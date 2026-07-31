import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, cloudScopeBindings, resourceAttributions } from "@paperclipai/db";
import type { ProjectInventory } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { findRepoCheckout, attributionRefreshIntervalMs, runAttributionRefresh } from "../observe/attribution-refresh.js";
import { run } from "../apex/exec.js";

vi.mock("../apex/exec.js", () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attribution-refresh tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const EXACT_REPORT = {
  exact: [
    {
      resource: { name: "//storage.googleapis.com/finpilot-dev-uploads" },
      workflow: "finpilot_infrastructure",
      workflow_path: ".apex/workflows/finpilot-infrastructure.yml",
      repo: "sarala-ai/FinPilot",
      step_name: "create_upload_bucket",
      inputs: { environment: "dev" },
      evidence: ".github/workflows/deploy-environment.yml:181",
    },
  ],
};

const PROJECT_INVENTORY: ProjectInventory = {
  projectId: "finpilot-dev",
  totalResources: 1,
  resourceTypes: 1,
  resourcesByType: {
    "storage.googleapis.com/Bucket": [{ name: "//storage.googleapis.com/finpilot-dev-uploads" }],
  },
};

describe("findRepoCheckout", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "attribution-refresh-roots-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves owner/name to <root>/name when it exists and is a git checkout", () => {
    const repoDir = join(root, "FinPilot");
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    expect(findRepoCheckout("sarala-ai/FinPilot", [root])).toBe(repoDir);
  });

  it("returns null when the directory doesn't exist", () => {
    expect(findRepoCheckout("sarala-ai/Nope", [root])).toBeNull();
  });

  it("returns null when the directory exists but isn't a git checkout", () => {
    mkdirSync(join(root, "NotGit"), { recursive: true });
    expect(findRepoCheckout("sarala-ai/NotGit", [root])).toBeNull();
  });

  it("tries later roots when an earlier one doesn't have the repo", () => {
    const root2 = mkdtempSync(join(tmpdir(), "attribution-refresh-roots2-"));
    try {
      const repoDir = join(root2, "Bloom");
      mkdirSync(join(repoDir, ".git"), { recursive: true });
      expect(findRepoCheckout("sarala-ai/Bloom", [root, root2])).toBe(repoDir);
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });
});

describe("attributionRefreshIntervalMs", () => {
  it("defaults to 24h when unset", () => {
    expect(attributionRefreshIntervalMs({})).toBe(24 * 60 * 60 * 1000);
  });

  it("honors APEX_ATTRIBUTION_REFRESH_HOURS", () => {
    expect(attributionRefreshIntervalMs({ APEX_ATTRIBUTION_REFRESH_HOURS: "6" })).toBe(6 * 60 * 60 * 1000);
  });

  it("returns 0 (disabled) when set to 0", () => {
    expect(attributionRefreshIntervalMs({ APEX_ATTRIBUTION_REFRESH_HOURS: "0" })).toBe(0);
  });

  it("falls back to the default on a garbage value", () => {
    expect(attributionRefreshIntervalMs({ APEX_ATTRIBUTION_REFRESH_HOURS: "not-a-number" })).toBe(24 * 60 * 60 * 1000);
  });
});

describeEmbeddedPostgres("runAttributionRefresh", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let repoRoot: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attribution-refresh-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "attribution-refresh-repo-"));
    mockRun.mockReset();
  });

  afterEach(async () => {
    rmSync(repoRoot, { recursive: true, force: true });
    await db.delete(resourceAttributions);
    await db.delete(cloudScopeBindings);
    await db.delete(companies);
  });

  let seedCounter = 0;
  async function seedCompany(githubRepos: string[], gcpProjects: string[]) {
    seedCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: `Attribution Refresh Co ${seedCounter}`, issuePrefix: `AREF${seedCounter}` })
      .returning();
    await db.insert(cloudScopeBindings).values({
      scopeType: "company",
      scopeId: company!.id,
      githubRepos,
      gcpProjects,
    });
    return company!;
  }

  it("skips cleanly, classified, when no local checkout exists for a bound repo", async () => {
    const company = await seedCompany(["sarala-ai/NoCheckoutHere"], ["finpilot-dev"]);
    const inventoryStore = { listResources: vi.fn().mockResolvedValue([PROJECT_INVENTORY]) };

    const summary = await runAttributionRefresh(db, { repoRoots: [repoRoot], inventoryStore, log: () => {} });

    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({
      companyId: company.id,
      repo: "sarala-ai/NoCheckoutHere",
      status: "skipped_no_checkout",
    });
    expect(mockRun).not.toHaveBeenCalled();
    const rows = await db.select().from(resourceAttributions);
    expect(rows).toHaveLength(0);
  });

  it("runs the mapper + imports exact mappings when a checkout exists", async () => {
    const company = await seedCompany(["sarala-ai/FinPilot"], ["finpilot-dev"]);
    mkdirSync(join(repoRoot, "FinPilot", ".git"), { recursive: true });
    const inventoryStore = { listResources: vi.fn().mockResolvedValue([PROJECT_INVENTORY]) };

    mockRun.mockImplementation(async (_bin, args) => {
      const jsonOutIdx = args.indexOf("--json-out");
      const reportPath = args[jsonOutIdx + 1] as string;
      writeFileSync(reportPath, JSON.stringify(EXACT_REPORT));
      return { status: "ok", stdout: "" };
    });

    const summary = await runAttributionRefresh(db, { repoRoots: [repoRoot], inventoryStore, log: () => {} });

    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({
      companyId: company.id,
      repo: "sarala-ai/FinPilot",
      projectId: "finpilot-dev",
      status: "imported",
      result: { imported: 1, updated: 0, skippedManual: 0, skippedNoResource: 0 },
    });

    expect(mockRun).toHaveBeenCalledTimes(1);
    const [bin, args] = mockRun.mock.calls[0]!;
    expect(bin).toBe("apex");
    expect(args).toEqual(
      expect.arrayContaining([
        "resource-mapper",
        "--repo",
        join(repoRoot, "FinPilot"),
        "--repo-name",
        "sarala-ai/FinPilot",
      ]),
    );

    const rows = await db.select().from(resourceAttributions).where(eq(resourceAttributions.projectId, "finpilot-dev"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "auto_mapped", workflow: "finpilot_infrastructure", repo: "sarala-ai/FinPilot" });
  });

  it("surfaces a CLI failure as a classified entry without throwing the job down", async () => {
    const company = await seedCompany(["sarala-ai/FinPilot"], ["finpilot-dev"]);
    mkdirSync(join(repoRoot, "FinPilot", ".git"), { recursive: true });
    const inventoryStore = { listResources: vi.fn().mockResolvedValue([PROJECT_INVENTORY]) };

    mockRun.mockResolvedValue({ status: "failed", code: 1, stderr: "boom: workflow not found", stdout: "" });

    const summary = await runAttributionRefresh(db, { repoRoots: [repoRoot], inventoryStore, log: () => {} });

    expect(summary.entries).toHaveLength(1);
    expect(summary.entries[0]).toMatchObject({
      companyId: company.id,
      repo: "sarala-ai/FinPilot",
      projectId: "finpilot-dev",
      status: "failed",
    });
    expect(summary.entries[0]!.detail).toContain("boom");

    const rows = await db.select().from(resourceAttributions);
    expect(rows).toHaveLength(0);
  });

  it("skips a company with no bound repos or no bound projects entirely", async () => {
    await seedCompany([], ["finpilot-dev"]);
    await seedCompany(["sarala-ai/FinPilot"], []);
    const inventoryStore = { listResources: vi.fn() };

    const summary = await runAttributionRefresh(db, { repoRoots: [repoRoot], inventoryStore, log: () => {} });

    expect(summary.entries).toHaveLength(0);
    expect(inventoryStore.listResources).not.toHaveBeenCalled();
  });
});
