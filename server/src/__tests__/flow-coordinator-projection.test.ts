/**
 * Coordinator ↔ projection wiring tests. The coordinator's knowledge of the
 * GitHub projection is exactly a set of thin, fire-and-forget hook calls on
 * an injectable `FlowProjectionHooks` — these tests pin WHICH lifecycle
 * points emit, and WHAT each event carries. The projection's own GitHub
 * behavior is covered in github-projection.test.ts.
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
import type { FlowProjectionHooks } from "../apex/flow/github-projection.js";
import type { FlowDefinition, LoadedFlowDefinition } from "../apex/flow/definition.js";
import type { FlowNodeRunner, NodeExecutionResult } from "../apex/flow/node-executors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres flow-coordinator projection tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type RecordedEvent = { kind: string; payload: Record<string, unknown> };

function recordingProjection() {
  const events: RecordedEvent[] = [];
  const push =
    (kind: string) =>
    async (payload: Record<string, unknown>): Promise<void> => {
      events.push({ kind, payload });
    };
  const projection: FlowProjectionHooks = {
    flowStarted: push("flowStarted"),
    agentRunCommissioned: push("agentRunCommissioned"),
    acceptanceEvaluated: push("acceptanceEvaluated"),
    gateOpened: push("gateOpened"),
    gateDecided: push("gateDecided"),
    flowCompleted: push("flowCompleted"),
    flowFailed: push("flowFailed"),
  };
  const kinds = () => events.map((event) => event.kind);
  const byKind = (kind: string) => events.filter((event) => event.kind === kind);
  return { projection, events, kinds, byKind };
}

function loaderFor(flow: FlowDefinition) {
  return async (name: string): Promise<LoadedFlowDefinition> => {
    if (name !== flow.name) throw new Error(`unexpected flow name ${name}`);
    return { path: `/fake/flows/${name}.yml`, flow };
  };
}

const ok: NodeExecutionResult = { ok: true, detail: { status: "success" } };

function okRunner(): FlowNodeRunner {
  return {
    runWorkflow: async () => ok,
    runCheck: async () => ok,
  };
}

describeEmbeddedPostgres("flow coordinator projection wiring", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-flow-projection-");
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

  async function seedIssue() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "APEX",
      issuePrefix: `T${Math.floor(Math.random() * 100000)}`,
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "projection wiring issue",
      identifier: `APE-${Math.floor(Math.random() * 100000)}`,
    });
    return { companyId, issueId };
  }

  it("emits flowStarted at start and flowCompleted (with final node) at the terminal", async () => {
    const { issueId } = await seedIssue();
    const flow: FlowDefinition = {
      name: "wf",
      version: "1.0",
      description: "d",
      ticket_type: "chore",
      nodes: [
        { id: "run", kind: "workflow", workflow: { workflow: "x", params: {} }, on_fail: "pause" },
      ],
    } as FlowDefinition;
    const { projection, kinds, byKind } = recordingProjection();
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(flow),
      nodeRunner: okRunner(),
      projection,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "wf" });
    await started.execution;

    expect(kinds()).toEqual(["flowStarted", "flowCompleted"]);
    expect(byKind("flowStarted")[0].payload).toMatchObject({ issueId, flowName: "wf" });
    expect(byKind("flowCompleted")[0].payload).toMatchObject({
      issueId,
      completedNodeId: "run",
      acceptanceEvaluation: null,
    });
  });

  it("emits gateOpened when an approve gate parks, then gateDecided + flowCompleted on approval", async () => {
    const { issueId } = await seedIssue();
    const flow: FlowDefinition = {
      name: "gated",
      version: "1.0",
      description: "d",
      ticket_type: "chore",
      nodes: [
        {
          id: "review",
          kind: "gate",
          gate: { mode: "approve", prompt: "Ship it?" },
          on_fail: "pause",
        },
      ],
    } as FlowDefinition;
    const { projection, kinds, byKind } = recordingProjection();
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(flow),
      nodeRunner: okRunner(),
      projection,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "gated" });
    await started.execution;

    expect(kinds()).toEqual(["flowStarted", "gateOpened"]);
    const gateEvent = byKind("gateOpened")[0].payload;
    expect(gateEvent).toMatchObject({ issueId, nodeId: "review", prompt: "Ship it?" });
    expect(typeof gateEvent.approvalId).toBe("string");

    const [approval] = await db.select().from(approvals);
    const decision = await coordinator.onGateDecision({
      approvalId: approval.id,
      payload: approval.payload,
      decision: "approve",
      decidedByUserId: "founder",
    });
    if ("execution" in decision && decision.execution) await decision.execution;

    expect(kinds()).toEqual(["flowStarted", "gateOpened", "gateDecided", "flowCompleted"]);
    expect(byKind("gateDecided")[0].payload).toMatchObject({
      issueId,
      nodeId: "review",
      decision: "approve",
      decidedByUserId: "founder",
      approvalId: approval.id,
    });
  });

  it("emits gateDecided(reject) and no completion when the gate is rejected", async () => {
    const { issueId } = await seedIssue();
    const flow: FlowDefinition = {
      name: "gated",
      version: "1.0",
      description: "d",
      ticket_type: "chore",
      nodes: [
        { id: "review", kind: "gate", gate: { mode: "approve" }, on_fail: "pause" },
      ],
    } as FlowDefinition;
    const { projection, kinds, byKind } = recordingProjection();
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(flow),
      nodeRunner: okRunner(),
      projection,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "gated" });
    await started.execution;

    const [approval] = await db.select().from(approvals);
    await coordinator.onGateDecision({
      approvalId: approval.id,
      payload: approval.payload,
      decision: "reject",
      decidedByUserId: "founder",
    });

    expect(kinds()).toEqual(["flowStarted", "gateOpened", "gateDecided"]);
    expect(byKind("gateDecided")[0].payload).toMatchObject({ decision: "reject" });
  });

  it("emits agentRunCommissioned at commission, then acceptanceEvaluated and flowCompleted (threading the acceptance evaluation) on run completion", async () => {
    const { issueId, companyId } = await seedIssue();
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "worker" });
    await db.update(issues).set({ assigneeAgentId: agentId }).where(eq(issues.id, issueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued" });

    const flow: FlowDefinition = {
      name: "agentic",
      version: "1.0",
      description: "d",
      ticket_type: "design-change",
      nodes: [
        {
          id: "board_diff",
          kind: "agent",
          agent: { prompt_template: "do {{identifier}}", acceptance: "a diff exists" },
          on_fail: "pause",
        },
      ],
    } as FlowDefinition;
    const evaluation =
      "v1: run success + pr_exists verified (acme/repo#x → https://github.com/acme/repo/pull/9).";
    const { projection, kinds, byKind } = recordingProjection();
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(flow),
      nodeRunner: okRunner(),
      commissionAgentRun: async () => ({ runId }),
      evaluateAcceptance: async () => ({ ok: true, evaluation }),
      projection,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
    await started.execution;

    expect(kinds()).toEqual(["flowStarted", "agentRunCommissioned"]);
    expect(byKind("agentRunCommissioned")[0].payload).toMatchObject({
      issueId,
      nodeId: "board_diff",
      runId,
    });

    const completion = await coordinator.onAgentRunCompletion({
      runId,
      issueId,
      flowName: "agentic",
      flowNodeId: "board_diff",
      runStatus: "succeeded",
    });
    if ("execution" in completion && completion.execution) await completion.execution;

    expect(kinds()).toEqual([
      "flowStarted",
      "agentRunCommissioned",
      "acceptanceEvaluated",
      "flowCompleted",
    ]);
    expect(byKind("acceptanceEvaluated")[0].payload).toMatchObject({
      issueId,
      nodeId: "board_diff",
      runId,
      ok: true,
      evaluation,
    });
    expect(byKind("flowCompleted")[0].payload).toMatchObject({
      issueId,
      completedNodeId: "board_diff",
      acceptanceEvaluation: evaluation,
    });
  });

  it("emits flowFailed with the classified failure when the flow dies", async () => {
    const { issueId } = await seedIssue();
    const flow: FlowDefinition = {
      name: "doomed",
      version: "1.0",
      description: "d",
      ticket_type: "chore",
      nodes: [
        { id: "run", kind: "workflow", workflow: { workflow: "x", params: {} }, on_fail: "pause" },
      ],
    } as FlowDefinition;
    const throwingRunner: FlowNodeRunner = {
      runWorkflow: async () => {
        throw new Error("runner exploded");
      },
      runCheck: async () => ok,
    };
    const { projection, kinds, byKind } = recordingProjection();
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(flow),
      nodeRunner: throwingRunner,
      projection,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "doomed" });
    await started.execution;

    expect(kinds()).toEqual(["flowStarted", "flowFailed"]);
    expect(byKind("flowFailed")[0].payload).toMatchObject({
      issueId,
      nodeId: "run",
      errorType: "flow_coordinator_error",
      message: "runner exploded",
    });
  });
});
