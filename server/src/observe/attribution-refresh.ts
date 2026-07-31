/**
 * Recurring attribution refresh (spec: resource-attribution-mapping,
 * "attribution persistence stops depending on a human running curl").
 *
 * Previously the only way `resource_attributions` rows got populated was a
 * human running `apex resource-mapper` by hand and POSTing the report to
 * `/observe/attribution/import`. This job automates that end to end, per
 * company: find a local checkout of each bound GitHub repo, run the mapper
 * against each bound GCP project's live inventory, and import the `exact`
 * mappings directly via `importMapperReport` (no HTTP round-trip — this runs
 * in-process, same as the route handler it replaces for the scheduled case).
 *
 * Failure-isolated at every level: a company with no usable checkout, a CLI
 * failure, or a single project's inventory error is logged and skipped —
 * never throws out of the job, so one bad company/repo/project can't take
 * the scheduler down.
 */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { type Db, cloudScopeBindings, companies } from "@paperclipai/db";
import { run } from "../apex/exec.js";
import { GcpInventoryStore } from "./gcp-inventory-store.js";
import { importMapperReport, type ImportResult, type MapperReport } from "./resource-attribution-store.js";

/** One (company, repo checkout, project) attempt's outcome. */
export type AttributionRefreshEntry = {
  companyId: string;
  companyName: string | null;
  repo: string;
  projectId: string | null;
  status: "imported" | "skipped_no_checkout" | "skipped_no_inventory" | "failed";
  result?: ImportResult;
  detail: string;
};

export type AttributionRefreshSummary = {
  startedAt: string;
  finishedAt: string;
  entries: AttributionRefreshEntry[];
};

const REPORT_LOG_PREFIX = "[attribution-refresh]";

/** `owner/name` -> `<root>/<name>` for the first configured root that exists
 *  and is a git checkout. Returns null (never throws) when none match — a
 *  company with no local checkout of a bound repo is a normal, expected case
 *  (e.g. this instance simply isn't the one with that repo cloned). */
export function findRepoCheckout(repo: string, roots: string[]): string | null {
  const name = repo.includes("/") ? repo.slice(repo.lastIndexOf("/") + 1) : repo;
  for (const root of roots) {
    if (!root) continue;
    const candidate = join(root, name);
    try {
      if (!existsSync(candidate)) continue;
      if (!statSync(candidate).isDirectory()) continue;
      if (!existsSync(join(candidate, ".git"))) continue;
      return candidate;
    } catch {
      // Unreadable path (permissions, race with deletion) — treat as absent.
      continue;
    }
  }
  return null;
}

export function repoRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.APEX_REPO_ROOTS?.trim();
  if (!raw) return ["/Users/srinivas/Dev/repos/sarala_org"];
  return raw.split(":").map((s) => s.trim()).filter(Boolean);
}

/** Companies with BOTH bound GitHub repos and bound GCP projects — anything
 *  less has nothing for this job to reconcile. */
async function companiesWithBindings(
  db: Db,
): Promise<Array<{ companyId: string; companyName: string | null; githubRepos: string[]; gcpProjects: string[] }>> {
  const rows = await db
    .select({
      scopeId: cloudScopeBindings.scopeId,
      githubRepos: cloudScopeBindings.githubRepos,
      gcpProjects: cloudScopeBindings.gcpProjects,
    })
    .from(cloudScopeBindings)
    .where(eq(cloudScopeBindings.scopeType, "company"));

  const bound = rows.filter((r) => (r.githubRepos?.length ?? 0) > 0 && (r.gcpProjects?.length ?? 0) > 0);
  if (bound.length === 0) return [];

  const companyRows = await db.select({ id: companies.id, name: companies.name }).from(companies);
  const nameById = new Map(companyRows.map((c) => [c.id, c.name]));

  return bound.map((r) => ({
    companyId: r.scopeId,
    companyName: nameById.get(r.scopeId) ?? null,
    githubRepos: r.githubRepos ?? [],
    gcpProjects: r.gcpProjects ?? [],
  }));
}

/** Invokes `apex resource-mapper` directly (a top-level CLI subcommand, not
 *  the `apex run <server> <tool>` shape `CliApexInvoker` wraps — resource-mapper
 *  reads/writes its own files rather than emitting the run-envelope JSON), and
 *  parses its `--json-out` report. PATH is widened with `~/.local/bin` since
 *  that's where `pip install --user`/pipx put the `apex` entrypoint on this
 *  fork's dev boxes; APEX_BIN still overrides the binary name outright. */
async function runResourceMapper(
  repoPath: string,
  inventoryPath: string,
  repoName: string,
  reportPath: string,
): Promise<MapperReport> {
  const bin = process.env.APEX_BIN ?? "apex";
  const pathEnv = `${process.env.PATH ?? ""}:${join(homedir(), ".local", "bin")}`;
  const res = await run(
    bin,
    ["resource-mapper", "--repo", repoPath, "--inventory", inventoryPath, "--repo-name", repoName, "--json-out", reportPath],
    60_000,
    undefined,
    { PATH: pathEnv },
  );
  if (res.status === "missing") {
    throw new Error(`apex CLI not found (bin: ${bin})`);
  }
  if (res.status === "failed") {
    throw new Error(`apex resource-mapper failed (code ${res.code}): ${res.stderr.slice(0, 500)}`);
  }
  const raw = await readFile(reportPath, "utf8");
  return JSON.parse(raw) as MapperReport;
}

/**
 * Runs one full refresh pass: every company with bound repos + projects,
 * every bound repo that has a local checkout, against every bound project's
 * live inventory. Returns a summary regardless of individual failures —
 * this function itself never throws.
 */
export async function runAttributionRefresh(
  db: Db,
  opts: {
    repoRoots?: string[];
    inventoryStore?: Pick<GcpInventoryStore, "listResources">;
    log?: (line: string) => void;
  } = {},
): Promise<AttributionRefreshSummary> {
  const startedAt = new Date().toISOString();
  const repoRoots = opts.repoRoots ?? repoRootsFromEnv();
  const inventoryStore = opts.inventoryStore ?? new GcpInventoryStore(db);
  const log = opts.log ?? ((line: string) => console.log(`${REPORT_LOG_PREFIX} ${line}`));

  const entries: AttributionRefreshEntry[] = [];
  const companiesToRefresh = await companiesWithBindings(db);

  for (const company of companiesToRefresh) {
    // One inventory fetch per company (already scoped to its bound
    // projects) — reused across every repo checkout for that company.
    let inventories: Awaited<ReturnType<GcpInventoryStore["listResources"]>> = [];
    try {
      inventories = await inventoryStore.listResources(company.companyId);
    } catch (e) {
      log(
        `company=${company.companyId} inventory fetch failed: ${e instanceof Error ? e.message : String(e)} — skipping company`,
      );
      continue;
    }
    const inventoryByProject = new Map(inventories.map((inv) => [inv.projectId, inv]));

    for (const repo of company.githubRepos) {
      const repoPath = findRepoCheckout(repo, repoRoots);
      if (!repoPath) {
        const entry: AttributionRefreshEntry = {
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          projectId: null,
          status: "skipped_no_checkout",
          detail: `no local checkout of ${repo} found under [${repoRoots.join(", ")}]`,
        };
        entries.push(entry);
        log(`company=${company.companyId} repo=${repo} skipped (no local checkout)`);
        continue;
      }

      for (const projectId of company.gcpProjects) {
        const inventory = inventoryByProject.get(projectId);
        if (!inventory || inventory.error) {
          const entry: AttributionRefreshEntry = {
            companyId: company.companyId,
            companyName: company.companyName,
            repo,
            projectId,
            status: "skipped_no_inventory",
            detail: inventory?.error ?? "no inventory entry for this project",
          };
          entries.push(entry);
          log(`company=${company.companyId} repo=${repo} project=${projectId} skipped (no inventory: ${entry.detail})`);
          continue;
        }

        let workDir: string | null = null;
        try {
          workDir = await mkdtemp(join(tmpdir(), "apex-attribution-"));
          const inventoryPath = join(workDir, "inventory.json");
          const reportPath = join(workDir, "report.json");
          await writeFile(inventoryPath, JSON.stringify({ resourcesByType: inventory.resourcesByType }), "utf8");

          const report = await runResourceMapper(repoPath, inventoryPath, repo, reportPath);
          const result = await importMapperReport(db, company.companyId, projectId, report);

          entries.push({
            companyId: company.companyId,
            companyName: company.companyName,
            repo,
            projectId,
            status: "imported",
            result,
            detail: `imported=${result.imported} updated=${result.updated} skippedManual=${result.skippedManual} skippedNoResource=${result.skippedNoResource}`,
          });
          log(
            `company=${company.companyId} repo=${repo} project=${projectId} imported=${result.imported} updated=${result.updated} skippedManual=${result.skippedManual} skippedNoResource=${result.skippedNoResource}`,
          );
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          entries.push({
            companyId: company.companyId,
            companyName: company.companyName,
            repo,
            projectId,
            status: "failed",
            detail,
          });
          log(`company=${company.companyId} repo=${repo} project=${projectId} FAILED: ${detail}`);
        } finally {
          if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  }

  return { startedAt, finishedAt: new Date().toISOString(), entries };
}

/** Interval (ms) from `APEX_ATTRIBUTION_REFRESH_HOURS` (default 24h, 0 disables). */
export function attributionRefreshIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APEX_ATTRIBUTION_REFRESH_HOURS;
  if (raw === undefined || raw.trim() === "") return 24 * 60 * 60 * 1000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return 24 * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

/** First-run delay after boot (fixed 5 minutes — the job reads live cloud
 *  inventory + shells a subprocess per repo/project, so it's deliberately not
 *  on the fast startup-reconciliation path other monitors use). */
export const ATTRIBUTION_REFRESH_INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * Wires the recurring refresh into server startup, following the same
 * `setInterval` scheduling shape as the other background monitors (heartbeat
 * scheduler tick, database backup) registered in `index.ts`. Returns a
 * disposer that clears both timers — call it on shutdown. A 0-hour interval
 * (env override) disables scheduling entirely; the caller can still trigger
 * a run on demand via `runAttributionRefresh` directly (used by the manual
 * `POST /observe/attribution/refresh` route).
 */
export function startAttributionRefreshScheduler(
  db: Db,
  opts: { intervalMs?: number; initialDelayMs?: number; log?: (line: string) => void } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? attributionRefreshIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? ATTRIBUTION_REFRESH_INITIAL_DELAY_MS;
  const log = opts.log ?? ((line: string) => console.log(`${REPORT_LOG_PREFIX} ${line}`));

  if (intervalMs <= 0) {
    log("scheduling disabled (APEX_ATTRIBUTION_REFRESH_HOURS=0)");
    return () => {};
  }

  let interval: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    void runAttributionRefresh(db, { log }).catch((e) => {
      log(`refresh run failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  const timeout = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
  }, initialDelayMs);

  return () => {
    clearTimeout(timeout);
    if (interval) clearInterval(interval);
  };
}
