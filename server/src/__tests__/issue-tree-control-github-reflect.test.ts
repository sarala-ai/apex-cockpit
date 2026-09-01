/**
 * Finding 5c/5d (adversarial architecture review): `cancelIssueStatusesForHold`
 * writes to `issues` directly (bulk tree-control cancel), bypassing
 * issueService.update — the one place the GitHub reflect hook now fires
 * from. This exercises the reflect call added directly to that bulk path,
 * and the 5d rule that a still-backlog mirror's local cancel never writes
 * upstream (only a previously-promoted mirror's cancel does).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, issueTreeHoldMembers, issueTreeHolds, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockReflect = vi.hoisted(() => vi.fn(async () => ({ action: "closed" as const, detail: "ok" })));

vi.mock("../apex/pipeline/github-issue-reflect.js", () => ({
  reflectGithubIssueTransition: mockReflect,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-tree-control github-reflect tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cancelIssueStatusesForHold github reflect trigger", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let issueTreeControlService: typeof import("../services/issue-tree-control.js").issueTreeControlService;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-tree-control-github-reflect-");
    db = createDb(tempDb.connectionString);
    ({ issueTreeControlService } = await import("../services/issue-tree-control.js"));
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
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
      .values({ name: `Tree Cancel Reflect Co ${seedCounter}`, issuePrefix: `TCR${seedCounter}` })
      .returning();
    return company!;
  }

  it("fires the reflect hook (with a real previous/next snapshot) for a promoted plugin:github root cancelled via bulk tree control", async () => {
    const company = await seedCompany();
    const rootIssueId = randomUUID();
    await db.insert(issues).values({
      id: rootIssueId,
      companyId: company.id,
      title: "Promoted GitHub issue",
      status: "todo",
      priority: "medium",
      originKind: "plugin:github",
      originId: "acme/repo#9",
      originFingerprint: "github:acme/repo#9",
    });

    const svc = issueTreeControlService(db);
    const cancel = await svc.createHold(company.id, rootIssueId, {
      mode: "cancel",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    await svc.cancelIssueStatusesForHold(company.id, rootIssueId, cancel.hold.id);

    expect(mockReflect).toHaveBeenCalledTimes(1);
    const [prevArg, nextArg] = mockReflect.mock.calls[0]!;
    expect(prevArg).toMatchObject({ status: "todo", originKind: "plugin:github", originId: "acme/repo#9" });
    expect(nextArg).toMatchObject({ status: "cancelled", originKind: "plugin:github", originId: "acme/repo#9" });
  });

  it("also fires (wiring-only) for a still-backlog plugin:github root — the gate against an upstream write lives in reflectGithubIssueTransition itself (Finding 5d)", async () => {
    const company = await seedCompany();
    const rootIssueId = randomUUID();
    await db.insert(issues).values({
      id: rootIssueId,
      companyId: company.id,
      title: "Still-backlog GitHub issue",
      status: "backlog",
      priority: "medium",
      originKind: "plugin:github",
      originId: "acme/repo#10",
      originFingerprint: "github:acme/repo#10",
    });

    const svc = issueTreeControlService(db);
    const cancel = await svc.createHold(company.id, rootIssueId, {
      mode: "cancel",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    await svc.cancelIssueStatusesForHold(company.id, rootIssueId, cancel.hold.id);

    expect(mockReflect).toHaveBeenCalledTimes(1);
    const [prevArg, nextArg] = mockReflect.mock.calls[0]!;
    expect(prevArg).toMatchObject({ status: "backlog" });
    expect(nextArg).toMatchObject({ status: "cancelled" });
  });

  it("does not fire for a manual-origin issue cancelled via bulk tree control", async () => {
    const company = await seedCompany();
    const rootIssueId = randomUUID();
    await db.insert(issues).values({
      id: rootIssueId,
      companyId: company.id,
      title: "Manual issue",
      status: "todo",
      priority: "medium",
    });

    const svc = issueTreeControlService(db);
    const cancel = await svc.createHold(company.id, rootIssueId, {
      mode: "cancel",
      actor: { actorType: "user", actorId: "board-user", userId: "board-user" },
    });
    await svc.cancelIssueStatusesForHold(company.id, rootIssueId, cancel.hold.id);

    expect(mockReflect).not.toHaveBeenCalled();
  });
});
