/**
 * The guard that must not be lost when the flow front-end is deleted.
 *
 * `applyGovernedAdapterConfigOverride` has, today, exactly ONE production
 * caller: the flow coordinator. The claude-local adapter reads
 * `dangerouslySkipPermissions` with a DEFAULT OF TRUE
 * (packages/adapters/claude-local/src/server/execute.ts) — that default is
 * correct for a human sitting in front of a terminal approving prompts, and
 * catastrophic for a run nobody is watching. So the coordinator's override is
 * the only thing standing between "unattended agent step" and "unattended
 * agent step with permissions skipped", and deleting the coordinator without
 * carrying it across would remove the guard from the product entirely while
 * every test still passed.
 *
 * These tests pin the property at the seam it actually has to hold at:
 * `commissionBoundedAgentRun`, which every agent step goes through.
 *
 * They assert on the EFFECTIVE CONFIG, not on a call happening. Asserting that
 * `applyStepRunPermissionOverride` was invoked would pass just as happily if
 * it were invoked AFTER dispatch, which governs nothing — the run has already
 * been handed over by then. So the dispatch seam captures what is true on the
 * issue row at the instant the run is dispatched, and that is what is checked.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";
import { SANDBOX_ALLOWED_TOOLS } from "@paperclipai/adapter-claude-local/server";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  applyStepRunPermissionOverride,
  clearStepRunPermissionOverride,
  commissionBoundedAgentRun,
} from "../apex/steps/commission.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("commissioning a bounded agent run is always governed", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-step-commission-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(adapterOverrides: Record<string, unknown> | null = null) {
    const [company] = await db.insert(companies).values({
      name: "Substrate Co",
      issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const [agent] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Executor",
      role: "engineer",
    }).returning();
    const [issue] = await db.insert(issues).values({
      companyId: company!.id,
      title: "Do the bounded thing",
      status: "todo",
      assigneeAgentId: agent!.id,
      assigneeAdapterOverrides: adapterOverrides,
    }).returning();
    return { company: company!, agent: agent!, issue: issue! };
  }

  function overridesOf(issueId: string) {
    return db
      .select({ overrides: issues.assigneeAdapterOverrides })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.overrides as Record<string, unknown> | null);
  }

  /*
   * The load-bearing one. If the override were applied after dispatch — or not
   * at all — this fails, because it reads the row at dispatch time rather than
   * afterwards.
   */
  it("has the governed override on the issue BEFORE the run is dispatched", async () => {
    const { agent, issue } = await seed();
    let atDispatch: Record<string, unknown> | null = null;

    await commissionBoundedAgentRun(
      db,
      {
        issueId: issue.id,
        agentId: agent.id,
        instructionCommentId: randomUUID(),
        permissions: undefined,
        definitionName: "design-change",
        stepKey: "board_diff",
      },
      async () => {
        atDispatch = await overridesOf(issue.id);
        return { id: randomUUID() };
      },
    );

    expect(atDispatch).not.toBeNull();
    // The adapter's own default for this key is TRUE. Reading `false` here is
    // the whole point: something actively turned it off for this run.
    expect(atDispatch!.dangerouslySkipPermissions).toBe(false);
    expect(atDispatch!.allowedTools).toBe(SANDBOX_ALLOWED_TOOLS);
  });

  it("governs a step that declares NO permissions at all — the safest default, not the loosest", async () => {
    const { agent, issue } = await seed();
    let atDispatch: Record<string, unknown> | null = null;
    await commissionBoundedAgentRun(
      db,
      {
        issueId: issue.id,
        agentId: agent.id,
        instructionCommentId: randomUUID(),
        // Undeclared, garbage and unrecognised all land here in practice —
        // apex-core never emitted this key, so "absent" is the common case.
        permissions: "not-an-object",
        definitionName: "bug",
        stepKey: "repro_fix",
      },
      async () => {
        atDispatch = await overridesOf(issue.id);
        return { id: randomUUID() };
      },
    );
    expect(atDispatch!.dangerouslySkipPermissions).toBe(false);
    expect(atDispatch!.allowedTools).toBe(SANDBOX_ALLOWED_TOOLS);
  });

  /*
   * An issue a human has configured must not be trampled — but the two
   * permission keys are not the human's to keep. This pins both halves,
   * because "preserve what the operator set" is exactly the reasoning that
   * would otherwise be used to justify preserving a `true`.
   */
  it("overrides a pre-existing dangerouslySkipPermissions=true and preserves unrelated config", async () => {
    const { agent, issue } = await seed({
      dangerouslySkipPermissions: true,
      model: "claude-opus-4-6",
    });
    let atDispatch: Record<string, unknown> | null = null;
    await commissionBoundedAgentRun(
      db,
      {
        issueId: issue.id,
        agentId: agent.id,
        instructionCommentId: randomUUID(),
        permissions: { profile: "read-only-broad" },
        definitionName: "feature",
        stepKey: "spec",
      },
      async () => {
        atDispatch = await overridesOf(issue.id);
        return { id: randomUUID() };
      },
    );
    expect(atDispatch!.dangerouslySkipPermissions).toBe(false);
    expect(atDispatch!.model).toBe("claude-opus-4-6");
    // A read-only profile must not carry a write tool.
    expect(String(atDispatch!.allowedTools)).not.toContain("Write");
  });

  it("still governs when the wake is DEFERRED — a null dispatch is not an ungoverned one", async () => {
    const { agent, issue } = await seed();
    const result = await commissionBoundedAgentRun(
      db,
      {
        issueId: issue.id,
        agentId: agent.id,
        instructionCommentId: randomUUID(),
        permissions: undefined,
        definitionName: "bug",
        stepKey: "repro_fix",
      },
      async () => null,
    );
    expect(result).toBeNull();
    // The override stays on the issue. Rolling it back on a deferral would
    // open a window: heartbeat PROMOTES a deferred wake later, and that
    // promoted run reads the issue's config when it dispatches.
    expect((await overridesOf(issue.id))!.dangerouslySkipPermissions).toBe(false);
  });

  it("clears only the two permission keys, leaving the operator's own config", async () => {
    const { agent, issue } = await seed({ model: "claude-opus-4-6" });
    await applyStepRunPermissionOverride(db, {
      issueId: issue.id,
      stepKey: "board_diff",
      permissions: undefined,
    });
    void agent;
    await clearStepRunPermissionOverride(db, issue.id);
    const after = await overridesOf(issue.id);
    expect(after).toEqual({ model: "claude-opus-4-6" });
  });
});
