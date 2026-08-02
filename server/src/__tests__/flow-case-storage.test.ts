/**
 * Flow runtime state lives on a case (execution-substrate merge, step 1).
 *
 * Three things are pinned here:
 *  1. a starting flow gets a case, linked to its issue with role `work`;
 *  2. the coordinator reads and writes THROUGH that case, and the issue's
 *     `flow*` columns keep mirroring it exactly;
 *  3. a stale advance now conflicts instead of silently landing — the APE-5
 *     defect shape, reproduced against a real coordinator path.
 *
 * Plus the 0166 data migration, which had to be idempotent and had to be a
 * no-op on a database where no flow ever ran.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issues,
  pipelineCaseIssueLinks,
  pipelineCases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { flowCoordinator } from "../apex/flow/coordinator.js";
import type { FlowDefinition, LoadedFlowDefinition } from "../apex/flow/definition.js";
import type { FlowNodeRunner, NodeExecutionResult } from "../apex/flow/node-executors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres flow-case tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BACKFILL_MIGRATION = fileURLToPath(
  new URL("../../../packages/db/src/migrations/0168_flow_case_backfill.sql", import.meta.url),
);

const ok: NodeExecutionResult = { ok: true, detail: { status: "success" } };

function loaderFor(...flows: FlowDefinition[]) {
  return async (name: string): Promise<LoadedFlowDefinition> => {
    const flow = flows.find((candidate) => candidate.name === name);
    if (!flow) throw new Error(`unexpected flow name ${name}`);
    return { path: `/fake/flows/${name}.yml`, flow };
  };
}

function scriptedRunner(results: Record<string, NodeExecutionResult>): FlowNodeRunner {
  return {
    runWorkflow: async (config) => results[config.workflow] ?? ok,
    runCheck: async (config) => results[config.tool] ?? ok,
  };
}

/** workflow → check → done. Two advances, so the case version must climb. */
function twoStepFlow(): FlowDefinition {
  return {
    name: "noop-verify",
    version: "1.0",
    description: "case storage test flow",
    ticket_type: "chore",
    nodes: [
      {
        id: "run",
        kind: "workflow",
        workflow: { workflow: "simple-test", params: {} },
        on_fail: "pause",
      },
      {
        id: "verify",
        kind: "check",
        check: { tool: "health report", args: [], pass_criteria: "exit_code == 0" },
        on_fail: "pause",
      },
    ],
  } as FlowDefinition;
}

/** A single agent node: the flow parks at `waiting_agent`, which is where the
 *  stale-snapshot race is reachable through real code. */
function agentFlow(): FlowDefinition {
  return {
    name: "agent-only",
    version: "1.0",
    description: "agent flow for the race regression",
    ticket_type: "design-change",
    nodes: [
      {
        id: "board_diff",
        kind: "agent",
        agent: {
          prompt_template: "Produce the diff for {{identifier}}",
          acceptance: "a rendered diff exists",
          permissions: { profile: "bounded" },
        },
        on_fail: "pause",
      },
    ],
  } as FlowDefinition;
}

/** A gate the flow parks on. `waiting_gate` is where an operator can close a
 *  flow (`abandonFlow`) and start a new one, which is what makes the ABA round
 *  trip reachable without a single test-only seam. */
function gateFlow(): FlowDefinition {
  return {
    name: "gate-only",
    version: "1.0",
    description: "gated flow for the race regression",
    ticket_type: "design-change",
    nodes: [
      { id: "gate1", kind: "gate", gate: { mode: "approve", prompt: "ship it?" }, on_fail: "pause" },
      { id: "run", kind: "workflow", workflow: { workflow: "simple-test", params: {} }, on_fail: "pause" },
    ],
  } as FlowDefinition;
}

describeEmbeddedPostgres("flow case storage", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let backfillSql = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-flow-cases-");
    db = createDb(tempDb.connectionString);
    backfillSql = await readFile(BACKFILL_MIGRATION, "utf8");
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCases);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let prefixCounter = 0;

  async function seedIssue(overrides: Partial<typeof issues.$inferInsert> = {}) {
    const companyId = randomUUID();
    // A distinct prefix per company: `companies.issue_prefix` is unique, and
    // several of these tests seed more than one company.
    prefixCounter += 1;
    await db.insert(companies).values({
      id: companyId,
      name: `APEX ${prefixCounter}`,
      issuePrefix: `AP${prefixCounter}`,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "flow case test issue",
      identifier: `APE-${Math.floor(Math.random() * 1_000_000)}`,
      ...overrides,
    });
    return { companyId, issueId };
  }

  /** The case a flow-driven issue runs on, found the way production finds it:
   *  through the `work` link, never by guessing at ids. */
  async function caseForIssue(issueId: string) {
    const rows = await db
      .select({ case: pipelineCases, role: pipelineCaseIssueLinks.role })
      .from(pipelineCases)
      .innerJoin(pipelineCaseIssueLinks, eq(pipelineCaseIssueLinks.caseId, pipelineCases.id))
      .where(and(eq(pipelineCaseIssueLinks.issueId, issueId), eq(pipelineCases.definitionKind, "flow")));
    return rows[0] ?? null;
  }

  async function issueFlowColumns(issueId: string) {
    const [row] = await db
      .select({
        flowName: issues.flowName,
        flowNodeId: issues.flowNodeId,
        flowStatus: issues.flowStatus,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row;
  }

  it("creates a case linked with role 'work' when a flow starts", async () => {
    const { companyId, issueId } = await seedIssue();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(agentFlow()),
      // Decline the commission so the flow parks on node 0 and the assertions
      // describe the START, not an accidental advance.
      commissionAgentRun: async () => null,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "agent-only" });
    await started.execution;

    const found = await caseForIssue(issueId);
    expect(found).not.toBeNull();
    expect(found!.role).toBe("work");
    expect(found!.case.companyId).toBe(companyId);
    expect(found!.case.definitionKind).toBe("flow");
    expect(found!.case.definitionRef).toBe("agent-only");
    expect(found!.case.stepKey).toBe("board_diff");
    expect(found!.case.caseKey).toBe(issue.identifier);
    expect(found!.case.title).toBe("flow case test issue");
    // A flow-defined case has no pipeline and no stage row — that is the whole
    // reason those two columns became nullable.
    expect(found!.case.pipelineId).toBeNull();
    expect(found!.case.stageId).toBeNull();
    expect(found!.case.terminalKind).toBeNull();
    expect(started.caseId).toBe(found!.case.id);
  });

  it("moves step_key and version through the case, and mirrors both onto the issue", async () => {
    const { issueId } = await seedIssue();
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(twoStepFlow()),
      nodeRunner: scriptedRunner({}),
    });

    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    const versionAtStart = started.caseVersion;
    await started.execution;

    const found = await caseForIssue(issueId);
    expect(found!.case.stepKey).toBe("verify");
    // Every transition bumps it: node_succeeded, advanced, node_succeeded,
    // completed. The exact count is not the point; monotonicity is.
    expect(found!.case.version).toBeGreaterThan(versionAtStart);
    expect(found!.case.terminalKind).toBe("done");
    expect(found!.case.terminalAt).toBeInstanceOf(Date);

    // The mirror still agrees with the case, column by column — the surfaces
    // that read the issue directly must not have noticed any of this.
    const columns = await issueFlowColumns(issueId);
    expect(columns.flowName).toBe(found!.case.definitionRef);
    expect(columns.flowNodeId).toBe(found!.case.stepKey);
    expect(columns.flowStatus).toBe("done");
  });

  it("maps a failed flow onto a cancelled case, and a paused one onto no terminal at all", async () => {
    const { issueId } = await seedIssue();
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(twoStepFlow()),
      nodeRunner: scriptedRunner({ "simple-test": { ok: false, errorType: "tool_failed", message: "boom" } }),
    });
    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await started.execution;

    // `pause` is the node's on_fail: the flow is stopped but NOT finished, so
    // the case must not claim a terminal.
    expect((await issueFlowColumns(issueId)).flowStatus).toBe("paused");
    expect((await caseForIssue(issueId))!.case.terminalKind).toBeNull();

    await coordinator.abandonFlow({ issueId });
    const abandoned = await caseForIssue(issueId);
    expect((await issueFlowColumns(issueId)).flowStatus).toBe("failed");
    expect(abandoned!.case.terminalKind).toBe("cancelled");
  });

  it("reuses and resets the issue's case when a second flow starts, and keeps the version climbing", async () => {
    const { issueId } = await seedIssue();
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(twoStepFlow(), agentFlow()),
      nodeRunner: scriptedRunner({}),
      commissionAgentRun: async () => null,
    });

    const first = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await first.execution;
    const afterFirst = await caseForIssue(issueId);
    expect(afterFirst!.case.terminalKind).toBe("done");

    const second = await coordinator.startFlow({ issueId, flowName: "agent-only" });
    await second.execution;

    const cases = await db.select().from(pipelineCases).where(eq(pipelineCases.companyId, afterFirst!.case.companyId));
    expect(cases).toHaveLength(1); // one case per issue, reset — not a second row
    const afterSecond = await caseForIssue(issueId);
    expect(afterSecond!.case.id).toBe(afterFirst!.case.id);
    expect(afterSecond!.case.definitionRef).toBe("agent-only");
    expect(afterSecond!.case.stepKey).toBe("board_diff");
    expect(afterSecond!.case.terminalKind).toBeNull();
    // The version does NOT restart. This is exactly what makes a snapshot
    // taken before the restart unusable after it (see the next test).
    expect(afterSecond!.case.version).toBeGreaterThan(afterFirst!.case.version);
  });

  /**
   * The APE-5 regression.
   *
   * APE-5 was closed `done` while its gate still read `waiting_gate`: two
   * writers, a stale read, and a write that landed silently because nothing
   * could tell it was stale. The old guard was a compare-and-set on
   * `(flow_status, flow_node_id)`, which cannot tell — that pair is not
   * monotonic, so a flow that leaves a state and comes back returns the pair
   * to a value a stale holder still matches.
   *
   * Reproduced here through real coordinator code, using no seam that does not
   * already exist (`loadDefinition` is injectable so tests need not read YAML):
   *
   *  - the flow parks at `waiting_gate` on `gate1`;
   *  - the gate is approved; `onGateDecision` reads the issue, THEN loads the
   *    definition — and it is still holding that snapshot while it does;
   *  - during that load the flow is CLOSED (abandoned by an operator) and a new
   *    one is started, which parks at `waiting_gate` on `gate1` again. The
   *    mirror pair is now byte-identical to the snapshot's;
   *  - the approval resumes and tries to advance.
   *
   * Before the case, that advance matched and drove the NEW flow with the OLD
   * gate's decision — a decision recorded against work it was never shown.
   * Now it meets a version that has moved on and raises the pipelines
   * `409 version_conflict`.
   */
  it("conflicts instead of silently advancing when a close and a restart race an advance", async () => {
    const { issueId } = await seedIssue();

    let armed = false;
    let disrupted = false;
    let stateDuringRace: { caseId: string; version: number; stepKey: string | null } | null = null;

    const coordinator = flowCoordinator(db, {
      nodeRunner: scriptedRunner({}),
      loadDefinition: async (name) => {
        const loaded = await loaderFor(gateFlow())(name);
        if (armed && !disrupted) {
          disrupted = true; // set FIRST: the nested calls load the definition too
          await coordinator.abandonFlow({ issueId });
          const restarted = await coordinator.startFlow({ issueId, flowName: "gate-only" });
          await restarted.execution;
          const live = await caseForIssue(issueId);
          stateDuringRace = { caseId: live!.case.id, version: live!.case.version, stepKey: live!.case.stepKey };
        }
        return loaded;
      },
    });

    const started = await coordinator.startFlow({ issueId, flowName: "gate-only" });
    await started.execution;
    expect((await issueFlowColumns(issueId)).flowStatus).toBe("waiting_gate");

    armed = true;
    await expect(
      coordinator.onGateDecision({
        approvalId: randomUUID(),
        payload: { issueId, nodeId: "gate1", flowName: "gate-only" },
        decision: "approve",
        decidedByUserId: "founder",
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "version_conflict" } });

    expect(disrupted).toBe(true);
    // The pair the old compare-and-set guarded on is back to exactly what the
    // stale snapshot held — which is precisely why it could not have caught this.
    const columns = await issueFlowColumns(issueId);
    expect(columns.flowStatus).toBe("waiting_gate");
    expect(columns.flowNodeId).toBe("gate1");
    // And the restarted flow is untouched: a conflict, not a divergence.
    const after = await caseForIssue(issueId);
    expect(after!.case.id).toBe(stateDuringRace!.caseId);
    expect(after!.case.version).toBe(stateDuringRace!.version);
    expect(after!.case.stepKey).toBe(stateDuringRace!.stepKey);
    expect(after!.case.terminalKind).toBeNull();
  });

  describe("0166 flow-case backfill", () => {
    async function runBackfill() {
      await db.execute(sql.raw(backfillSql));
    }

    it("creates a case from the issue's flow columns, and does it once", async () => {
      const { issueId } = await seedIssue({
        flowName: "design-change",
        flowNodeId: "board_diff",
        flowStatus: "waiting_gate",
        flowStartedAt: new Date("2026-07-01T00:00:00Z"),
        flowAdvancedAt: new Date("2026-07-02T00:00:00Z"),
      });

      await runBackfill();
      const found = await caseForIssue(issueId);
      expect(found).not.toBeNull();
      expect(found!.role).toBe("work");
      expect(found!.case.definitionKind).toBe("flow");
      expect(found!.case.definitionRef).toBe("design-change");
      expect(found!.case.stepKey).toBe("board_diff");
      // waiting_gate is not a terminal — a gate that never fired must not be
      // recorded as a closure. That confusion is the defect this whole change
      // exists to make impossible.
      expect(found!.case.terminalKind).toBeNull();
      expect(found!.case.createdAt).toEqual(new Date("2026-07-01T00:00:00Z"));

      await runBackfill();
      const all = await db.select().from(pipelineCases);
      expect(all).toHaveLength(1);
    });

    it("maps done to done and failed to cancelled", async () => {
      const { issueId: doneIssue } = await seedIssue({
        flowName: "chore",
        flowNodeId: "verify",
        flowStatus: "done",
        flowAdvancedAt: new Date("2026-07-03T00:00:00Z"),
      });
      const { issueId: failedIssue } = await seedIssue({
        flowName: "bug",
        flowNodeId: "repro",
        flowStatus: "failed",
        flowAdvancedAt: new Date("2026-07-04T00:00:00Z"),
      });

      await runBackfill();

      expect((await caseForIssue(doneIssue))!.case.terminalKind).toBe("done");
      expect((await caseForIssue(failedIssue))!.case.terminalKind).toBe("cancelled");
      expect((await caseForIssue(failedIssue))!.case.terminalAt).toEqual(new Date("2026-07-04T00:00:00Z"));
    });

    it("is a no-op when the flow columns are null, and skips a row with no step to point at", async () => {
      await seedIssue();
      // A status without a node has no step to record. Inventing one would put
      // a fiction into the authoritative pointer, so the row is left alone.
      await seedIssue({ flowName: "chore", flowStatus: "paused" });

      await runBackfill();
      await runBackfill();

      expect(await db.select().from(pipelineCases)).toHaveLength(0);
    });
  });
});
