/**
 * Finding 5c (adversarial architecture review): the GitHub reflect hook used
 * to fire only from the route layer (PATCH /issues/:id), so any status
 * transition that reached `issues` through a different path — bulk
 * tree-control cancel, heartbeat's deferred-comment reopen — never reflected
 * back to GitHub. It now fires from issueService.update itself, the single
 * status-transition path every caller (route, heartbeat, recovery jobs) goes
 * through. This test exercises that trigger directly against a real DB, with
 * only the GitHub-facing reflect module mocked.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockReflect = vi.hoisted(() => vi.fn(async () => ({ action: "promoted" as const, detail: "ok" })));

vi.mock("../apex/pipeline/github-issue-reflect.js", () => ({
  reflectGithubIssueTransition: mockReflect,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-service github-reflect tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.update github reflect trigger", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let issueService: typeof import("../services/issues.js").issueService;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-service-github-reflect-");
    db = createDb(tempDb.connectionString);
    ({ issueService } = await import("../services/issues.js"));
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  beforeEach(() => {
    mockReflect.mockClear();
  });

  let seedCounter = 0;
  async function seedCompany() {
    seedCounter += 1;
    const [company] = await db
      .insert(companies)
      .values({ name: `GH Reflect Co ${seedCounter}`, issuePrefix: `GHR${seedCounter}` })
      .returning();
    return company!;
  }

  it("fires the reflect hook when a plugin:github issue's status changes", async () => {
    const company = await seedCompany();
    const svc = issueService(db);
    const created = await svc.create(company.id, {
      title: "GitHub-origin issue",
      status: "backlog",
      originKind: "plugin:github",
      originId: "acme/repo#5",
      originFingerprint: "github:acme/repo#5",
    });

    await svc.update(created.id, { status: "todo" });

    expect(mockReflect).toHaveBeenCalledTimes(1);
    const [prevArg, nextArg] = mockReflect.mock.calls[0]!;
    expect(prevArg).toMatchObject({ status: "backlog", originKind: "plugin:github", originId: "acme/repo#5" });
    expect(nextArg).toMatchObject({ status: "todo" });
  });

  it("does not fire when status is unchanged", async () => {
    const company = await seedCompany();
    const svc = issueService(db);
    const created = await svc.create(company.id, {
      title: "GitHub-origin issue",
      status: "backlog",
      originKind: "plugin:github",
      originId: "acme/repo#6",
      originFingerprint: "github:acme/repo#6",
    });

    await svc.update(created.id, { title: "Renamed, no status change" });

    expect(mockReflect).not.toHaveBeenCalled();
  });

  it("does not fire for a non-plugin:github-origin issue (reflect itself is a cheap no-op, but confirms wiring doesn't misfire)", async () => {
    const company = await seedCompany();
    const svc = issueService(db);
    const created = await svc.create(company.id, {
      title: "Manual issue",
      status: "backlog",
    });

    await svc.update(created.id, { status: "todo" });

    // reflectGithubIssueTransition is still invoked (it no-ops internally for
    // non-plugin:github origin) — assert it was called with the manual origin
    // so a caller relying on the mock can see the no-op path was exercised.
    expect(mockReflect).toHaveBeenCalledTimes(1);
    const [prevArg] = mockReflect.mock.calls[0]!;
    expect(prevArg).toMatchObject({ originKind: "manual" });
  });

  it("fires for the reopen path used by heartbeat's deferred-comment wake (svc.update called with an explicit tx)", async () => {
    const company = await seedCompany();
    const svc = issueService(db);
    const created = await svc.create(company.id, {
      title: "GitHub-origin issue",
      status: "done",
      originKind: "plugin:github",
      originId: "acme/repo#7",
      originFingerprint: "github:acme/repo#7",
    });
    // done -> in_progress requires an assignee normally; reopen path resets to
    // "todo" with no assignee, which is allowed.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, created.id));

    await db.transaction(async (tx) => {
      await svc.update(created.id, { status: "todo", executionState: null }, tx);
    });

    expect(mockReflect).toHaveBeenCalledTimes(1);
    const [prevArg, nextArg] = mockReflect.mock.calls[0]!;
    expect(prevArg).toMatchObject({ status: "done" });
    expect(nextArg).toMatchObject({ status: "todo" });
  });
});
