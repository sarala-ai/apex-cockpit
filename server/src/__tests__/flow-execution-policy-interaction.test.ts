/**
 * CONSOLIDATION EVIDENCE — flow gates vs. execution policy on the SAME issue.
 *
 * Three review mechanisms now exist in this fork (flow gates, pipeline review
 * stages, per-issue execution policy). Flow gates and execution policy can
 * both be active on one issue today, and neither knows about the other. These
 * tests pin down what actually happens, so the consolidation argument rests on
 * observed behaviour rather than on reading two files side by side.
 *
 * They assert the CURRENT behaviour, including where it is wrong. Each such
 * assertion is labelled so that fixing the behaviour fails the test loudly
 * rather than silently drifting.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { flowCoordinator } from "../apex/flow/coordinator.js";
import { noopFlowProjection } from "../apex/flow/github-projection.js";
import type { FlowDefinition, LoadedFlowDefinition } from "../apex/flow/definition.js";
import type { FlowNodeRunner } from "../apex/flow/node-executors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

const idleRunner: FlowNodeRunner = {
  runWorkflow: async () => ({ ok: true, detail: {} }),
  runCheck: async () => ({ ok: true, detail: {} }),
};

/** design-change shaped: an authoring agent step, then an approve gate. */
function agentGateFlow(): FlowDefinition {
  return {
    name: "agent-gate",
    version: "1.0",
    description: "authoring step then a human gate",
    ticket_type: "design-change",
    nodes: [
      {
        id: "author",
        kind: "agent",
        agent: { prompt_template: "Do the work for {{identifier}}", acceptance: "work exists", budget: null },
        on_fail: "pause",
      },
      { id: "review_gate", kind: "gate", gate: { mode: "approve", prompt: "Check it" }, on_fail: "pause" },
    ],
  } as FlowDefinition;
}

function loaderFor(flow: FlowDefinition) {
  return async (): Promise<LoadedFlowDefinition> => ({
    path: `/fake/${flow.name}.yml`,
    flow,
    reviewPasses: {},
  });
}

describeEmbeddedPostgres("flow gates vs execution policy on the same issue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-flow-execpolicy-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(options: { assigneeAgentId?: string | null; executionState?: unknown } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "APEX" });
    const executorId = randomUUID();
    const reviewerId = randomUUID();
    await db.insert(agents).values([
      { id: executorId, companyId, name: "executor" },
      { id: reviewerId, companyId, name: "reviewer" },
    ]);
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "flow + execution policy",
      identifier: `APE-${Math.floor(Math.random() * 100000)}`,
      assigneeAgentId: options.assigneeAgentId === undefined ? executorId : options.assigneeAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: randomUUID(),
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId, userId: null }],
          },
        ],
      },
      ...(options.executionState !== undefined
        ? { executionState: options.executionState as Record<string, unknown> }
        : {}),
    });
    return { companyId, issueId, executorId, reviewerId };
  }

  function coordinatorFor(commissioned: Array<{ agentId: string; nodeId: string }>) {
    return flowCoordinator(db, {
      loadDefinition: loaderFor(agentGateFlow()),
      nodeRunner: idleRunner,
      projection: noopFlowProjection,
      evaluateAcceptance: async () => ({ ok: true, evaluation: "test" }),
      commissionAgentRun: async (issue, node, commission) => {
        commissioned.push({ agentId: commission.agentId, nodeId: node.id });
        // A real run row: issues.flow_run_id carries an FK.
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId: issue.companyId,
          agentId: commission.agentId,
          status: "running",
        });
        return { runId };
      },
    });
  }

  it("CONFLICT: the flow commissions its agent step to whoever executionPolicy last assigned — including the reviewer", async () => {
    // Reproduces the shape execution policy leaves behind after it intercepts
    // a done-transition: status in_review, issue REASSIGNED to the reviewer.
    const { issueId, executorId, reviewerId } = await seed();
    await db
      .update(issues)
      .set({ status: "in_review", assigneeAgentId: reviewerId })
      .where(eq(issues.id, issueId));

    const commissioned: Array<{ agentId: string; nodeId: string }> = [];
    const started = await coordinatorFor(commissioned).startFlow({ issueId, flowName: "agent-gate" });
    await started.execution;

    expect(commissioned).toHaveLength(1);
    // WRONG-BUT-CURRENT: the flow's authoring step runs as the REVIEWER,
    // because resolveExecutorAgent trusts issues.assigneeAgentId and execution
    // policy owns that column too. Independent verification is silently lost.
    expect(commissioned[0]).toMatchObject({ nodeId: "author", agentId: reviewerId });
    expect(commissioned[0].agentId).not.toBe(executorId);
  });

  it("the coordinator neither reads nor clears executionState — the two state machines are blind to each other", async () => {
    const pendingReviewState = {
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
    const { issueId } = await seed({ executionState: pendingReviewState });

    const commissioned: Array<{ agentId: string; nodeId: string }> = [];
    const coordinator = coordinatorFor(commissioned);
    const started = await coordinator.startFlow({ issueId, flowName: "agent-gate" });
    await started.execution;

    // The flow commissioned a run even though execution policy considers this
    // issue to be parked in a pending human/agent review stage.
    expect(commissioned).toHaveLength(1);

    const [row] = await db
      .select({ executionState: issues.executionState, status: issues.status, flowStatus: issues.flowStatus })
      .from(issues)
      .where(eq(issues.id, issueId));
    // executionState untouched: no clearing, no advancing, no awareness.
    expect(row.executionState).toMatchObject({ status: "pending" });
    // And the flow parked in its OWN wait state, unrelated to issue status.
    expect(row.flowStatus).toBe("waiting_agent");
  });

  it("a flow gate opens an approval WITHOUT consulting executionPolicy's participants", async () => {
    const { issueId, reviewerId } = await seed();
    const commissioned: Array<{ agentId: string; nodeId: string }> = [];
    const coordinator = coordinatorFor(commissioned);
    const started = await coordinator.startFlow({ issueId, flowName: "agent-gate" });
    await started.execution;

    const [state] = await db.select({ flowRunId: issues.flowRunId }).from(issues).where(eq(issues.id, issueId));
    await coordinator.onAgentRunCompletion({
      runId: state.flowRunId as string,
      issueId,
      flowName: "agent-gate",
      flowNodeId: "author",
      runStatus: "succeeded",
    });

    const approvalRows = await db.select().from(approvals);
    expect(approvalRows).toHaveLength(1);
    // The gate approval names no reviewer at all: any board user may decide it.
    // The issue's executionPolicy names a specific reviewer agent, and the gate
    // is unaware of them — two definitions of "who reviews this" on one ticket.
    expect(approvalRows[0].payload).not.toHaveProperty("participants");
    expect(JSON.stringify(approvalRows[0].payload)).not.toContain(reviewerId);
  });
});
