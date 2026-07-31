import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, cloudScopeBindings, createDb, issues, issueComments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  githubIngestIntervalMs,
  githubOriginFingerprint,
  runGithubIssueIngest,
} from "../apex/pipeline/github-issue-ingest.js";
import type { TicketSource } from "../apex/pipeline/ticket-source.js";
import { ok, err } from "../apex/errors.js";
import type { Ticket } from "../apex/pipeline/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres github-issue-ingest tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "acme/repo#1",
    source: "github",
    repo: "acme/repo",
    number: 1,
    title: "Bug A",
    body: "desc A",
    url: "https://github.com/acme/repo/issues/1",
    status: "open",
    ...overrides,
  };
}

function fakeSource(list: (repo: string) => ReturnType<TicketSource["list"]>): TicketSource {
  return {
    list,
    get: vi.fn(async () => ({ ...err("empty", "unused"), source: "unused" })) as TicketSource["get"],
    updateStatus: vi.fn(async () => ok(true)) as TicketSource["updateStatus"],
  };
}

describe("githubIngestIntervalMs", () => {
  it("defaults to 6h when unset", () => {
    expect(githubIngestIntervalMs({})).toBe(6 * 60 * 60 * 1000);
  });

  it("honors APEX_GITHUB_INGEST_HOURS", () => {
    expect(githubIngestIntervalMs({ APEX_GITHUB_INGEST_HOURS: "2" })).toBe(2 * 60 * 60 * 1000);
  });

  it("returns 0 (disabled) when set to 0", () => {
    expect(githubIngestIntervalMs({ APEX_GITHUB_INGEST_HOURS: "0" })).toBe(0);
  });

  it("falls back to the default on a garbage value", () => {
    expect(githubIngestIntervalMs({ APEX_GITHUB_INGEST_HOURS: "nope" })).toBe(6 * 60 * 60 * 1000);
  });
});

describe("githubOriginFingerprint", () => {
  it("namespaces the ticket id under github:", () => {
    expect(githubOriginFingerprint("acme/repo#1")).toBe("github:acme/repo#1");
  });
});

describeEmbeddedPostgres("runGithubIssueIngest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-issue-ingest-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(cloudScopeBindings);
    await db.delete(companies);
  });

  let seedCounter = 0;
  async function seedCompany(githubRepos: string[]) {
    seedCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: `GitHub Ingest Co ${seedCounter}`, issuePrefix: `GHI${seedCounter}` })
      .returning();
    await db.insert(cloudScopeBindings).values({
      scopeType: "company",
      scopeId: company!.id,
      githubRepos,
      gcpProjects: [],
    });
    return company!;
  }

  async function getFork(companyId: string, ticketId: string) {
    const rows = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originFingerprint, githubOriginFingerprint(ticketId))));
    return rows[0] ?? null;
  }

  it("creates a new backlog fork issue for each open GitHub issue", async () => {
    const company = await seedCompany(["acme/repo"]);
    const source = fakeSource(async () => ({ ...ok([ticket()]), source: "gh" }));

    const summary = await runGithubIssueIngest(db, { source, log: () => {} });

    expect(summary.entries).toEqual([
      expect.objectContaining({ companyId: company.id, repo: "acme/repo", originId: "acme/repo#1", action: "created" }),
    ]);
    const row = await getFork(company.id, "acme/repo#1");
    expect(row).toMatchObject({
      title: "Bug A",
      description: "desc A",
      status: "backlog",
      originKind: "plugin:github",
      originId: "acme/repo#1",
    });
    expect(row!.identifier).toBeTruthy();
  });

  it("is idempotent: re-ingesting the same issue does not duplicate or touch it", async () => {
    const company = await seedCompany(["acme/repo"]);
    const source = fakeSource(async () => ({ ...ok([ticket()]), source: "gh" }));

    await runGithubIssueIngest(db, { source, log: () => {} });
    const second = await runGithubIssueIngest(db, { source, log: () => {} });

    expect(second.entries).toEqual([
      expect.objectContaining({ action: "unchanged" }),
    ]);
    const rows = await db
      .select()
      .from(issues)
      .where(eq(issues.originFingerprint, githubOriginFingerprint("acme/repo#1")));
    expect(rows).toHaveLength(1);
  });

  it("updates title/description on re-ingest while the fork issue is still backlog", async () => {
    const company = await seedCompany(["acme/repo"]);
    let calls = 0;
    const source = fakeSource(async () => {
      calls += 1;
      const t = calls === 1 ? ticket() : ticket({ title: "Bug A v2", body: "desc A v2" });
      return { ...ok([t]), source: "gh" };
    });

    await runGithubIssueIngest(db, { source, log: () => {} });
    const second = await runGithubIssueIngest(db, { source, log: () => {} });

    expect(second.entries).toEqual([expect.objectContaining({ action: "updated" })]);
    const row = await getFork(company.id, "acme/repo#1");
    expect(row).toMatchObject({ title: "Bug A v2", description: "desc A v2", status: "backlog" });
  });

  it("never touches a fork issue that has been promoted out of backlog", async () => {
    const company = await seedCompany(["acme/repo"]);
    const source = fakeSource(async () => ({ ...ok([ticket()]), source: "gh" }));
    await runGithubIssueIngest(db, { source, log: () => {} });

    const created = await getFork(company.id, "acme/repo#1");
    // Bypass the issue service (which enforces in_progress requiring an
    // assignee) — the point here is purely "the ingest job must not touch a
    // promoted issue", not exercising the promotion path itself.
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, created!.id));

    const source2 = fakeSource(async () => ({ ...ok([ticket({ title: "Bug A CHANGED" })]), source: "gh" }));
    const summary = await runGithubIssueIngest(db, { source: source2, log: () => {} });

    expect(summary.entries).toEqual([expect.objectContaining({ action: "skipped_not_backlog" })]);
    const row = await getFork(company.id, "acme/repo#1");
    expect(row!.title).toBe("Bug A"); // untouched
    expect(row!.status).toBe("in_progress");
  });

  it("cancels a still-backlog fork issue whose GitHub issue has since closed", async () => {
    const company = await seedCompany(["acme/repo"]);
    const source = fakeSource(async () => ({ ...ok([ticket()]), source: "gh" }));
    await runGithubIssueIngest(db, { source, log: () => {} });

    const closedSource = fakeSource(async () => ({ ...ok([]), source: "gh" }));
    const summary = await runGithubIssueIngest(db, { source: closedSource, log: () => {} });

    expect(summary.entries).toEqual([
      expect.objectContaining({ action: "cancelled_closed_on_github", originId: "acme/repo#1" }),
    ]);
    const row = await getFork(company.id, "acme/repo#1");
    expect(row!.status).toBe("cancelled");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, row!.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("Closed on GitHub");
  });

  it("does not cancel an issue that has already been promoted, even if closed on GitHub", async () => {
    const company = await seedCompany(["acme/repo"]);
    const source = fakeSource(async () => ({ ...ok([ticket()]), source: "gh" }));
    await runGithubIssueIngest(db, { source, log: () => {} });
    const created = await getFork(company.id, "acme/repo#1");
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, created!.id));

    const closedSource = fakeSource(async () => ({ ...ok([]), source: "gh" }));
    const summary = await runGithubIssueIngest(db, { source: closedSource, log: () => {} });

    expect(summary.entries).toEqual([]);
    const row = await getFork(company.id, "acme/repo#1");
    expect(row!.status).toBe("in_progress");
  });

  it("surfaces a source failure (gh missing/unauth) as a classified entry, never throwing", async () => {
    await seedCompany(["acme/repo"]);
    const source = fakeSource(async () => ({ ...err("tool-missing", "gh not installed"), source: "unavailable" }));

    const summary = await runGithubIssueIngest(db, { source, log: () => {} });

    expect(summary.entries).toEqual([
      expect.objectContaining({ action: "source_unavailable", detail: "gh not installed" }),
    ]);
    const rows = await db.select().from(issues);
    expect(rows).toHaveLength(0);
  });

  it("skips companies with no bound GitHub repos entirely", async () => {
    await seedCompany([]);
    const source = fakeSource(vi.fn());

    const summary = await runGithubIssueIngest(db, { source, log: () => {} });

    expect(summary.entries).toEqual([]);
    expect(source.list).not.toHaveBeenCalled();
  });
});
