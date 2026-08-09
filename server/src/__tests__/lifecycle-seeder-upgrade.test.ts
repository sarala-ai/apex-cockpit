/**
 * APEX-38 follow-through — the contract-target fix must REACH instances that
 * seeded their lifecycles before it landed.
 *
 * `seedLifecyclePipelines` was create-only: an existing pipeline row was
 * skipped wholesale, so a live instance seeded before APEX-38 kept
 * `pytest tests/unit` / `cloud_run_deploy` in its stage configs forever —
 * and every bug/feature case held at its check stage with
 * `command_tool_unresolvable` (observed live on APEX-38's own case).
 *
 * The contract these tests pin:
 *  - a stored lifecycle whose version is OLDER than the shipped definition is
 *    upgraded in place on reseed: stage configs rewritten by stage key,
 *    pipeline version/ticketType brought current;
 *  - stage IDs are preserved — live cases reference `stage_id`, an upgrade
 *    must never orphan them;
 *  - a stored lifecycle already at the shipped version is left untouched and
 *    reported as `existing`, same as before.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  approvals,
  companies,
  createDb,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { LIFECYCLE_DEFINITIONS, seedLifecyclePipelines } from "../apex/pipeline/lifecycles.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres lifecycle-upgrade tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** The stage configs an instance seeded BEFORE APEX-38 actually stored —
 *  copied verbatim from a live row, hardcoded tool and all. */
const PRE_APEX38_TESTS_CONFIG = {
  onEnter: {
    type: "run",
    target: { type: "command", tool: "pytest", args: ["tests/unit", "-q"] },
    onSuccessToStageKey: "diff_review",
  },
  approver: { kind: "any_human" },
  acceptance: { criteria: "exit_code == 0", disabled: true },
  requireApproval: false,
};

const PRE_APEX38_DEPLOY_CONFIG = {
  onEnter: {
    type: "run",
    target: { type: "workflow", workflow: "cloud_run_deploy", params: {} },
    onSuccessToStageKey: "done",
  },
  approver: { kind: "any_human" },
  requireApproval: false,
};

describeEmbeddedPostgres("reseeding upgrades a pre-APEX-38 lifecycle in place", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-upgrade-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const [company] = await db
      .insert(companies)
      .values({ name: "Upgrade Co", issuePrefix: "UPG" })
      .returning({ id: companies.id });
    return company!.id;
  }

  /** Rewind the stored `bug` lifecycle to what a pre-APEX-38 instance holds:
   *  version 1.0, pytest/cloud_run_deploy stage configs. */
  async function rewindBugLifecycle(companyId: string): Promise<{
    pipelineId: string;
    testsStageId: string;
    deployStageId: string;
  }> {
    const [pipeline] = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.companyId, companyId), eq(pipelines.key, "bug")));
    const pipelineId = pipeline!.id;

    await db.update(pipelines).set({ version: "1.0" }).where(eq(pipelines.id, pipelineId));
    await db
      .update(pipelineStages)
      .set({ config: PRE_APEX38_TESTS_CONFIG })
      .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.key, "tests")));
    await db
      .update(pipelineStages)
      .set({ config: PRE_APEX38_DEPLOY_CONFIG })
      .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.key, "deploy")));

    const stages = await db
      .select({ id: pipelineStages.id, key: pipelineStages.key })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId));
    const byKey = Object.fromEntries(stages.map((s) => [s.key, s.id]));
    return { pipelineId, testsStageId: byKey.tests!, deployStageId: byKey.deploy! };
  }

  async function storedStageTarget(pipelineId: string, stageKey: string) {
    const [stage] = await db
      .select({ config: pipelineStages.config })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.key, stageKey)));
    return (stage!.config as { onEnter?: { target?: unknown } }).onEnter?.target;
  }

  it("rewrites an older stored lifecycle's stage configs to the shipped contract targets", async () => {
    const companyId = await seedCompany();
    await seedLifecyclePipelines(db, { companyId });
    const { pipelineId } = await rewindBugLifecycle(companyId);

    const result = await seedLifecyclePipelines(db, { companyId });
    expect(result.upgraded).toContain("bug");

    expect(await storedStageTarget(pipelineId, "tests")).toEqual({
      type: "contract",
      contract: "checks_pass",
    });
    expect(await storedStageTarget(pipelineId, "deploy")).toEqual({
      type: "contract",
      contract: "deployed",
    });

    const shipped = LIFECYCLE_DEFINITIONS.find((d) => d.key === "bug")!;
    const [row] = await db
      .select({ version: pipelines.version, ticketType: pipelines.ticketType })
      .from(pipelines)
      .where(eq(pipelines.id, pipelineId));
    expect(row!.version).toBe(shipped.version);
    expect(row!.ticketType).toBe("bug");
    // The shipped definition must actually be newer than the pre-APEX-38 row,
    // or no live instance ever takes this upgrade path.
    expect(shipped.version).not.toBe("1.0");
  });

  it("preserves stage IDs across the upgrade — live cases reference them", async () => {
    const companyId = await seedCompany();
    await seedLifecyclePipelines(db, { companyId });
    const { pipelineId, testsStageId, deployStageId } = await rewindBugLifecycle(companyId);

    await seedLifecyclePipelines(db, { companyId });

    const stages = await db
      .select({ id: pipelineStages.id, key: pipelineStages.key })
      .from(pipelineStages)
      .where(eq(pipelineStages.pipelineId, pipelineId));
    const byKey = Object.fromEntries(stages.map((s) => [s.key, s.id]));
    expect(byKey.tests).toBe(testsStageId);
    expect(byKey.deploy).toBe(deployStageId);
  });

  it("leaves a lifecycle already at the shipped version untouched, reported as existing", async () => {
    const companyId = await seedCompany();
    await seedLifecyclePipelines(db, { companyId });

    const result = await seedLifecyclePipelines(db, { companyId });
    expect(result.existing).toEqual(
      expect.arrayContaining(LIFECYCLE_DEFINITIONS.map((d) => d.key)),
    );
    expect(result.upgraded ?? []).toHaveLength(0);
    expect(result.seeded).toHaveLength(0);
  });
});

/**
 * APEX-79: stranded cases re-materialization.
 *
 * Before APEX-78 (lifecycle v1.1), `failing_signal` was a check node
 * (kind="working"). The upgrade to v1.2 changed it to a gate node
 * (kind="review"). Cases that were stuck at the check stage carried:
 *  - `step_status = NULL` (swept from "waiting_agent" after the run expired)
 *  - a `step_held` event from the failed ci_failure_signal tool
 *
 * Both blocked `reviewCase`: the hold guard in `assertStageTransitionGates`
 * throws 409 when it finds an uncleared hold. The fix clears the hold and
 * opens the gate (setting `step_status = "waiting_gate"`) as part of the
 * upgrade path.
 */
describeEmbeddedPostgres("APEX-79: upgrade re-materializes stranded gate cases", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-apex79-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(approvals);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The stage config for `failing_signal` as it was in lifecycle version 1.1
  // (a check node pointing at the ci_failure_signal tool that never existed).
  const PRE_APEX78_FAILING_SIGNAL_CONFIG = {
    onEnter: {
      type: "run",
      target: { type: "command", tool: "ci_failure_signal", args: [] },
      onSuccessToStageKey: "repro_fix",
    },
    acceptance: { criteria: "failure_detected == true", disabled: true },
  };

  async function seedCompany(): Promise<string> {
    const [company] = await db
      .insert(companies)
      .values({ name: "Stranded Co", issuePrefix: "STC" })
      .returning({ id: companies.id });
    return company!.id;
  }

  /** Rewind the bug lifecycle to v1.1: failing_signal was a check (working) node. */
  async function rewindToV11(companyId: string) {
    const [pipeline] = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.companyId, companyId), eq(pipelines.key, "bug")));
    const pipelineId = pipeline!.id;

    await db.update(pipelines).set({ version: "1.1" }).where(eq(pipelines.id, pipelineId));
    await db
      .update(pipelineStages)
      .set({ kind: "working", config: PRE_APEX78_FAILING_SIGNAL_CONFIG })
      .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.key, "failing_signal")));

    const [stage] = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.key, "failing_signal")));
    return { pipelineId, failingSignalStageId: stage!.id };
  }

  /** Insert a case that was stranded at failing_signal with NULL step_status. */
  async function insertStrandedCase(input: {
    companyId: string;
    pipelineId: string;
    stageId: string;
  }) {
    const [caseRow] = await db
      .insert(pipelineCases)
      .values({
        companyId: input.companyId,
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        stepKey: "failing_signal",
        stepStatus: null,
        caseKey: "STC-1",
        title: "Stranded bug case",
        definitionKind: "pipeline",
        definitionRef: input.pipelineId,
      })
      .returning({ id: pipelineCases.id });
    return caseRow!.id;
  }

  /** Write the step_held event the failed ci_failure_signal check left behind. */
  async function insertStepHeldEvent(input: {
    companyId: string;
    caseId: string;
    stageId: string;
  }) {
    await db.insert(pipelineCaseEvents).values({
      companyId: input.companyId,
      caseId: input.caseId,
      type: "step_held",
      actorType: "system",
      payload: {
        stageId: input.stageId,
        stageKey: "failing_signal",
        reason: "command_tool_unresolvable",
        errorType: "command_tool_unresolvable",
        message: "No tool named ci_failure_signal",
        stepKey: "failing_signal",
      },
    });
  }

  it("sets step_status=waiting_gate and opens a pending approval for a stranded case", async () => {
    const companyId = await seedCompany();
    await seedLifecyclePipelines(db, { companyId });
    // Rewind to v1.1: failing_signal is a check (working) node.
    const { pipelineId, failingSignalStageId } = await rewindToV11(companyId);

    // Insert the stranded case as it would exist on a pre-APEX-78 instance.
    const caseId = await insertStrandedCase({ companyId, pipelineId, stageId: failingSignalStageId });
    await insertStepHeldEvent({ companyId, caseId, stageId: failingSignalStageId });

    // Upgrade to v1.2 — should re-materialize the stranded case.
    const result = await seedLifecyclePipelines(db, { companyId });
    expect(result.upgraded).toContain("bug");

    // The case must now be waiting at the gate, not stuck at NULL.
    const [caseAfter] = await db
      .select({ stepStatus: pipelineCases.stepStatus })
      .from(pipelineCases)
      .where(eq(pipelineCases.id, caseId));
    expect(caseAfter!.stepStatus).toBe("waiting_gate");

    // A pending gate approval must exist so the operator can approve.
    const [approval] = await db
      .select({ id: approvals.id, status: approvals.status })
      .from(approvals)
      .where(and(
        eq(approvals.companyId, companyId),
        sql`${approvals.payload} ->> 'caseId' = ${caseId}`,
        sql`${approvals.payload} ->> 'stepKey' = 'failing_signal'`,
      ));
    expect(approval).toBeDefined();
    expect(approval!.status).toBe("pending");
  });

  it("is idempotent: a second upgrade does not open a second approval", async () => {
    const companyId = await seedCompany();
    await seedLifecyclePipelines(db, { companyId });
    const { pipelineId, failingSignalStageId } = await rewindToV11(companyId);
    const caseId = await insertStrandedCase({ companyId, pipelineId, stageId: failingSignalStageId });
    await insertStepHeldEvent({ companyId, caseId, stageId: failingSignalStageId });

    // First upgrade fixes the stranded case.
    await seedLifecyclePipelines(db, { companyId });
    // Second run (already at shipped version) must be a no-op.
    await seedLifecyclePipelines(db, { companyId });

    const allApprovals = await db
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(
        eq(approvals.companyId, companyId),
        sql`${approvals.payload} ->> 'caseId' = ${caseId}`,
      ));
    expect(allApprovals).toHaveLength(1);
  });

  it("acceptance query: count of failing_signal cases with NULL step_status is 0 after upgrade", async () => {
    const companyId = await seedCompany();
    await seedLifecyclePipelines(db, { companyId });
    const { pipelineId, failingSignalStageId } = await rewindToV11(companyId);
    const caseId = await insertStrandedCase({ companyId, pipelineId, stageId: failingSignalStageId });
    await insertStepHeldEvent({ companyId, caseId, stageId: failingSignalStageId });

    await seedLifecyclePipelines(db, { companyId });

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pipelineCases)
      .where(and(
        eq(pipelineCases.stepKey, "failing_signal"),
        isNull(pipelineCases.stepStatus),
      ));
    expect(count).toBe(0);
  });
});
