/**
 * GitHub Issues → fork issues ingestion (work-loop doctrine, spec Slice 0 —
 * see docs/architecture/work-loop.md). Per the constitution's "single writer
 * per phase" table: GitHub Issues is the system of record for the
 * *statement* phase; once a fork issue is promoted out of `backlog` the
 * cockpit owns it and this job never touches it again. Two-way live sync is
 * explicitly ruled out — this is a polling mirror, not a webhook relay.
 *
 * Supersedes `IssueIngestionAdapter` (./ingest-service.ts), which mirrored
 * GitHub issues into pipeline `cases` because the fork's `issues` table had
 * no GitHub linkage at the time. It now does (`originKind: plugin:github`,
 * `originId`, `originFingerprint`), so this is the real ingestion target —
 * see that file's header for the deprecation note.
 *
 * Idempotency: `originFingerprint = github:{repo}#{number}` is a stable key
 * scoped to (companyId, fingerprint) — re-ingesting upserts rather than
 * duplicating, mirroring the `productivity-review.ts` /
 * `recovery/service.ts` fingerprint convention elsewhere in this service.
 *
 * Every company/repo/issue is failure-isolated: a bad repo, a `gh` failure,
 * or a single issue's upsert error is logged and skipped, never throws the
 * job down (same shape as `observe/attribution-refresh.ts`).
 */
import { and, eq } from "drizzle-orm";
import { type Db, cloudScopeBindings, companies, issues } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { GitHubIssuesSource } from "./ticket-source.js";
import type { TicketSource } from "./ticket-source.js";

export type GithubIssueIngestAction =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped_not_backlog"
  | "cancelled_closed_on_github"
  | "source_unavailable"
  | "failed";

export type GithubIssueIngestEntry = {
  companyId: string;
  companyName: string | null;
  repo: string;
  originId: string | null;
  action: GithubIssueIngestAction;
  detail: string;
};

export type GithubIssueIngestSummary = {
  startedAt: string;
  finishedAt: string;
  entries: GithubIssueIngestEntry[];
};

const LOG_PREFIX = "[github-issue-ingest]";

/** Stable dedupe key for a GitHub issue, scoped by company via the row's
 *  own companyId (not embedded in the fingerprint itself). */
export function githubOriginFingerprint(ticketId: string): string {
  return `github:${ticketId}`;
}

async function companiesWithGithubRepos(
  db: Db,
): Promise<Array<{ companyId: string; companyName: string | null; githubRepos: string[] }>> {
  const rows = await db
    .select({ scopeId: cloudScopeBindings.scopeId, githubRepos: cloudScopeBindings.githubRepos })
    .from(cloudScopeBindings)
    .where(eq(cloudScopeBindings.scopeType, "company"));
  const bound = rows.filter((r) => (r.githubRepos?.length ?? 0) > 0);
  if (bound.length === 0) return [];

  const companyRows = await db.select({ id: companies.id, name: companies.name }).from(companies);
  const nameById = new Map(companyRows.map((c) => [c.id, c.name]));

  return bound.map((r) => ({
    companyId: r.scopeId,
    companyName: nameById.get(r.scopeId) ?? null,
    githubRepos: r.githubRepos ?? [],
  }));
}

async function ingestRepoForCompany(
  db: Db,
  svc: ReturnType<typeof issueService>,
  source: TicketSource,
  company: { companyId: string; companyName: string | null },
  repo: string,
  log: (line: string) => void,
): Promise<GithubIssueIngestEntry[]> {
  const entries: GithubIssueIngestEntry[] = [];
  const listed = await source.list(repo);
  if (!listed.ok) {
    entries.push({
      companyId: company.companyId,
      companyName: company.companyName,
      repo,
      originId: null,
      action: "source_unavailable",
      detail: listed.message,
    });
    log(`company=${company.companyId} repo=${repo} source unavailable: ${listed.message}`);
    return entries;
  }

  const openOriginIds = new Set(listed.value.map((t) => t.id));

  for (const ticket of listed.value) {
    const fingerprint = githubOriginFingerprint(ticket.id);
    try {
      const existing = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, company.companyId), eq(issues.originFingerprint, fingerprint)))
        .then((rows) => rows[0] ?? null);

      if (!existing) {
        await svc.create(company.companyId, {
          title: ticket.title,
          description: ticket.body || null,
          status: "backlog",
          originKind: "plugin:github",
          originId: ticket.id,
          originFingerprint: fingerprint,
        });
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: ticket.id,
          action: "created",
          detail: `ingested from ${ticket.url}`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${ticket.id} created`);
        continue;
      }

      if (existing.status !== "backlog") {
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: ticket.id,
          action: "skipped_not_backlog",
          detail: `fork issue ${existing.identifier ?? existing.id} is ${existing.status} — cockpit owns it since promotion, not touched`,
        });
        continue;
      }

      const nextDescription = ticket.body || null;
      if (existing.title === ticket.title && (existing.description ?? null) === nextDescription) {
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: ticket.id,
          action: "unchanged",
          detail: "title/description already in sync",
        });
        continue;
      }

      await svc.update(existing.id, { title: ticket.title, description: nextDescription });
      entries.push({
        companyId: company.companyId,
        companyName: company.companyName,
        repo,
        originId: ticket.id,
        action: "updated",
        detail: "title/description refreshed from GitHub (still backlog, not yet promoted)",
      });
      log(`company=${company.companyId} repo=${repo} issue=${ticket.id} updated`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      entries.push({
        companyId: company.companyId,
        companyName: company.companyName,
        repo,
        originId: ticket.id,
        action: "failed",
        detail,
      });
      log(`company=${company.companyId} repo=${repo} issue=${ticket.id} FAILED: ${detail}`);
    }
  }

  // Closed-on-GitHub detection: `source.list` only returns open issues, so a
  // previously-ingested backlog issue whose originId no longer appears in
  // this pass is presumed closed upstream. Issues already promoted out of
  // backlog are untouched regardless (single-writer rule).
  try {
    const repoPrefix = `${repo}#`;
    const backlogRows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, company.companyId),
          eq(issues.originKind, "plugin:github"),
          eq(issues.status, "backlog"),
        ),
      );
    for (const row of backlogRows) {
      if (!row.originId || !row.originId.startsWith(repoPrefix)) continue;
      if (openOriginIds.has(row.originId)) continue;
      try {
        await svc.update(row.id, { status: "cancelled" });
        await svc.addComment(
          row.id,
          `Closed on GitHub (${repo}) while still in backlog — auto-cancelled by the GitHub ingest job.`,
          {},
          { authorType: "system" },
        );
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: row.originId,
          action: "cancelled_closed_on_github",
          detail: `fork issue ${row.identifier ?? row.id} cancelled — no longer open on GitHub`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${row.originId} cancelled (closed on GitHub)`);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: row.originId,
          action: "failed",
          detail: `closed-on-GitHub cancel failed: ${detail}`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${row.originId} FAILED to cancel: ${detail}`);
      }
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log(`company=${company.companyId} repo=${repo} closed-on-GitHub sweep FAILED: ${detail}`);
  }

  return entries;
}

/**
 * Runs one full ingest pass: every company with bound GitHub repos, every
 * bound repo. Returns a summary regardless of individual failures — this
 * function itself never throws.
 */
export async function runGithubIssueIngest(
  db: Db,
  opts: { source?: TicketSource; log?: (line: string) => void } = {},
): Promise<GithubIssueIngestSummary> {
  const startedAt = new Date().toISOString();
  const source = opts.source ?? new GitHubIssuesSource();
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} ${line}`));
  const svc = issueService(db);

  const entries: GithubIssueIngestEntry[] = [];
  const companiesToIngest = await companiesWithGithubRepos(db);

  for (const company of companiesToIngest) {
    for (const repo of company.githubRepos) {
      const repoEntries = await ingestRepoForCompany(db, svc, source, company, repo, log);
      entries.push(...repoEntries);
    }
  }

  return { startedAt, finishedAt: new Date().toISOString(), entries };
}

/** Interval (ms) from `APEX_GITHUB_INGEST_HOURS` (default 6h, 0 disables). */
export function githubIngestIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APEX_GITHUB_INGEST_HOURS;
  if (raw === undefined || raw.trim() === "") return 6 * 60 * 60 * 1000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return 6 * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

/** First-run delay after boot — same 5-minute deliberate offset as the
 *  attribution-refresh job (this shells `gh` per bound repo, not on the fast
 *  startup-reconciliation path other monitors use). */
export const GITHUB_INGEST_INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * Wires the recurring ingest into server startup, following the same
 * `setInterval` scheduling shape as `startAttributionRefreshScheduler`.
 * Returns a disposer that clears both timers — call it on shutdown. A
 * 0-hour interval (env override) disables scheduling entirely; the caller
 * can still trigger a run on demand via `runGithubIssueIngest` directly
 * (used by the manual `POST /apex/github-ingest` route).
 */
export function startGithubIssueIngestScheduler(
  db: Db,
  opts: { intervalMs?: number; initialDelayMs?: number; log?: (line: string) => void } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? githubIngestIntervalMs();
  const initialDelayMs = opts.initialDelayMs ?? GITHUB_INGEST_INITIAL_DELAY_MS;
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} ${line}`));

  if (intervalMs <= 0) {
    log("scheduling disabled (APEX_GITHUB_INGEST_HOURS=0)");
    return () => {};
  }

  let interval: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    void runGithubIssueIngest(db, { log }).catch((e) => {
      log(`ingest run failed: ${e instanceof Error ? e.message : String(e)}`);
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
