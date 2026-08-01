import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { flowCoordinator, FLOW_GATE_APPROVAL_TYPE } from "../apex/flow/coordinator.js";
import type { FlowDefinition, LoadedFlowDefinition } from "../apex/flow/definition.js";
import type { FlowNodeRunner, NodeExecutionResult } from "../apex/flow/node-executors.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres flow-coordinator tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type RunnerScript = Record<string, NodeExecutionResult[]>;

/** Deterministic fake runner: results keyed by workflow name / check tool. */
function fakeRunner(script: RunnerScript) {
  const calls: Array<{ kind: "workflow" | "check"; key: string; config: unknown }> = [];
  const next = (key: string): NodeExecutionResult => {
    const queue = script[key];
    if (!queue || queue.length === 0) {
      throw new Error(`fake runner has no scripted result for ${key}`);
    }
    return queue.shift() as NodeExecutionResult;
  };
  const runner: FlowNodeRunner = {
    runWorkflow: async (config) => {
      calls.push({ kind: "workflow", key: config.workflow, config });
      return next(config.workflow);
    },
    runCheck: async (config) => {
      calls.push({ kind: "check", key: config.tool, config });
      return next(config.tool);
    },
  };
  return { runner, calls };
}

function loaderFor(flow: FlowDefinition) {
  return async (name: string): Promise<LoadedFlowDefinition> => {
    if (name !== flow.name) throw new Error(`unexpected flow name ${name}`);
    return { path: `/fake/flows/${name}.yml`, flow };
  };
}

const ok: NodeExecutionResult = { ok: true, detail: { status: "success" } };
const fail: NodeExecutionResult = { ok: false, errorType: "tool_failed", message: "boom" };

function choreFlow(overrides: Partial<FlowDefinition> = {}): FlowDefinition {
  return {
    name: "noop-verify",
    version: "1.0",
    description: "test flow",
    ticket_type: "chore",
    nodes: [
      {
        id: "run",
        kind: "workflow",
        workflow: { workflow: "simple-test", params: { test_param: "x" } },
        on_fail: "pause",
      },
      {
        id: "verify",
        kind: "check",
        check: { tool: "health generate_health_report", args: [], pass_criteria: "exit_code == 0" },
        on_fail: "pause",
      },
    ],
    ...overrides,
  } as FlowDefinition;
}

describeEmbeddedPostgres("flow coordinator", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-flow-coordinator-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(options: { assigneeAgentId?: string | null } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "APEX" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "flow test issue",
      identifier: `APE-${Math.floor(Math.random() * 100000)}`,
      assigneeAgentId: options.assigneeAgentId ?? null,
    });
    return { companyId, issueId };
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "worker" });
    return agentId;
  }

  async function flowState(issueId: string) {
    const [row] = await db
      .select({
        flowName: issues.flowName,
        flowNodeId: issues.flowNodeId,
        flowStatus: issues.flowStatus,
        flowStartedAt: issues.flowStartedAt,
        flowAdvancedAt: issues.flowAdvancedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return row;
  }

  async function activityActions(issueId: string) {
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    return rows.map((row) => row.action);
  }

  it("drives a workflow+check flow from node 0 to done with stamps and classified logs", async () => {
    const { issueId } = await seedIssue();
    const { runner, calls } = fakeRunner({
      "simple-test": [ok],
      "health generate_health_report": [ok],
    });
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(choreFlow()),
      nodeRunner: runner,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    expect(started.flowNodeId).toBe("run");
    expect(started.flowStatus).toBe("running");
    await started.execution;

    const state = await flowState(issueId);
    expect(state.flowStatus).toBe("done");
    expect(state.flowName).toBe("noop-verify");
    expect(state.flowStartedAt).toBeInstanceOf(Date);
    expect(state.flowAdvancedAt).toBeInstanceOf(Date);
    expect(state.flowAdvancedAt!.getTime()).toBeGreaterThanOrEqual(state.flowStartedAt!.getTime());
    expect(calls.map((c) => c.kind)).toEqual(["workflow", "check"]);

    const actions = await activityActions(issueId);
    expect(actions).toContain("flow.started");
    expect(actions).toContain("flow.advanced");
    expect(actions).toContain("flow.completed");
    expect(actions.filter((a) => a === "flow.node_succeeded")).toHaveLength(2);
  });

  it("workflow failure with on_fail=pause pauses the flow and surfaces a classified comment", async () => {
    const { issueId } = await seedIssue();
    const { runner } = fakeRunner({ "simple-test": [fail] });
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(choreFlow()),
      nodeRunner: runner,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await started.execution;

    const state = await flowState(issueId);
    expect(state.flowStatus).toBe("paused");
    expect(state.flowNodeId).toBe("run");
    expect(await activityActions(issueId)).toContain("flow.paused");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("tool_failed");
    expect(comments[0].body).toContain("boom");
    expect(comments[0].authorType).toBe("system");
  });

  it("on_fail=skip advances past the failed node", async () => {
    const { issueId } = await seedIssue();
    const flow = choreFlow();
    flow.nodes[0].on_fail = "skip";
    const { runner } = fakeRunner({
      "simple-test": [fail],
      "health generate_health_report": [ok],
    });
    const coordinator = flowCoordinator(db, { loadDefinition: loaderFor(flow), nodeRunner: runner });

    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await started.execution;

    const state = await flowState(issueId);
    expect(state.flowStatus).toBe("done");
    expect(await activityActions(issueId)).toContain("flow.node_skipped");
  });

  it("on_fail=jump moves the pointer to the target node", async () => {
    const { issueId } = await seedIssue();
    const flow = choreFlow();
    flow.nodes[0].on_fail = "jump:verify";
    const { runner, calls } = fakeRunner({
      "simple-test": [fail],
      "health generate_health_report": [ok],
    });
    const coordinator = flowCoordinator(db, { loadDefinition: loaderFor(flow), nodeRunner: runner });

    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await started.execution;

    const state = await flowState(issueId);
    expect(state.flowStatus).toBe("done");
    expect(await activityActions(issueId)).toContain("flow.jumped");
    expect(calls.map((c) => c.key)).toEqual(["simple-test", "health generate_health_report"]);
  });

  it("an unresolvable check tool is a classified failure routed through on_fail", async () => {
    const { issueId } = await seedIssue();
    const flow = choreFlow();
    flow.nodes[1].check = { tool: "ci_status_check", args: [], pass_criteria: "exit_code == 0" };
    const { runner } = fakeRunner({
      "simple-test": [ok],
      ci_status_check: [
        { ok: false, errorType: "check_tool_unresolvable", message: "needs <server> <tool>" },
      ],
    });
    const coordinator = flowCoordinator(db, { loadDefinition: loaderFor(flow), nodeRunner: runner });

    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await started.execution;

    const state = await flowState(issueId);
    expect(state.flowStatus).toBe("paused");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments[0].body).toContain("check_tool_unresolvable");
  });

  describe("gate nodes", () => {
    function gatedFlow(mode: "approve" | "notify"): FlowDefinition {
      return {
        name: "gated",
        version: "1.0",
        description: "gated flow",
        ticket_type: "bug",
        nodes: [
          { id: "gate1", kind: "gate", gate: { mode, prompt: "Review it" }, on_fail: "pause" },
          {
            id: "deploy",
            kind: "workflow",
            workflow: { workflow: "simple-test", params: {} },
            on_fail: "pause",
          },
        ],
      } as FlowDefinition;
    }

    it("approve-mode gate creates a linked flow_gate approval and parks at waiting_gate", async () => {
      const { issueId } = await seedIssue();
      const { runner } = fakeRunner({});
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(gatedFlow("approve")),
        nodeRunner: runner,
      });

      const started = await coordinator.startFlow({ issueId, flowName: "gated" });
      await started.execution;

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("waiting_gate");
      expect(state.flowNodeId).toBe("gate1");

      const approvalRows = await db.select().from(approvals);
      expect(approvalRows).toHaveLength(1);
      expect(approvalRows[0].type).toBe(FLOW_GATE_APPROVAL_TYPE);
      expect(approvalRows[0].status).toBe("pending");
      expect(approvalRows[0].payload).toMatchObject({
        issueId,
        flowName: "gated",
        nodeId: "gate1",
        prompt: "Review it",
      });
      const links = await db.select().from(issueApprovals).where(eq(issueApprovals.issueId, issueId));
      expect(links).toHaveLength(1);
      expect(links[0].approvalId).toBe(approvalRows[0].id);
      expect(await activityActions(issueId)).toContain("flow.gate_opened");
    });

    it("gate approval decision advances past the gate and resumes execution", async () => {
      const { issueId } = await seedIssue();
      const { runner } = fakeRunner({ "simple-test": [ok] });
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(gatedFlow("approve")),
        nodeRunner: runner,
      });
      const started = await coordinator.startFlow({ issueId, flowName: "gated" });
      await started.execution;
      const [approval] = await db.select().from(approvals);

      const decision = await coordinator.onGateDecision({
        approvalId: approval.id,
        payload: approval.payload,
        decision: "approve",
        decidedByUserId: "founder",
      });
      expect(decision.resumed).toBe(true);
      if (decision.resumed) await decision.execution;

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("done");
      const actions = await activityActions(issueId);
      expect(actions).toContain("flow.gate_approved");
      expect(actions).toContain("flow.completed");
    });

    it("gate rejection pauses the flow and surfaces it", async () => {
      const { issueId } = await seedIssue();
      const { runner } = fakeRunner({});
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(gatedFlow("approve")),
        nodeRunner: runner,
      });
      const started = await coordinator.startFlow({ issueId, flowName: "gated" });
      await started.execution;
      const [approval] = await db.select().from(approvals);

      const decision = await coordinator.onGateDecision({
        approvalId: approval.id,
        payload: approval.payload,
        decision: "reject",
        decidedByUserId: "founder",
      });
      expect(decision).toMatchObject({ resumed: false, reason: "rejected" });

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("paused");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.includes("rejected"))).toBe(true);
    });

    it("a stale gate decision is a classified no-op", async () => {
      const { issueId } = await seedIssue();
      const { runner } = fakeRunner({});
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(gatedFlow("approve")),
        nodeRunner: runner,
      });
      const started = await coordinator.startFlow({ issueId, flowName: "gated" });
      await started.execution;
      const [approval] = await db.select().from(approvals);

      // Simulate the flow having moved on (e.g. operator reset) before decide.
      await db.update(issues).set({ flowStatus: "paused" }).where(eq(issues.id, issueId));

      const decision = await coordinator.onGateDecision({
        approvalId: approval.id,
        payload: approval.payload,
        decision: "approve",
        decidedByUserId: "founder",
      });
      expect(decision).toMatchObject({ resumed: false, reason: "stale_gate_decision" });
      expect((await flowState(issueId)).flowStatus).toBe("paused");
    });

    it("notify-mode gate surfaces a notification and advances immediately", async () => {
      const { issueId } = await seedIssue();
      const { runner } = fakeRunner({ "simple-test": [ok] });
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(gatedFlow("notify")),
        nodeRunner: runner,
      });

      const started = await coordinator.startFlow({ issueId, flowName: "gated" });
      await started.execution;

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("done");
      expect(await activityActions(issueId)).toContain("flow.gate_notified");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.includes("notify gate"))).toBe(true);
      expect(await db.select().from(approvals)).toHaveLength(0);
    });
  });

  describe("agent nodes (honest v1 placeholder)", () => {
    function agentFlow(): FlowDefinition {
      return {
        name: "agentic",
        version: "1.0",
        description: "agent flow",
        ticket_type: "design-change",
        nodes: [
          {
            id: "board_diff",
            kind: "agent",
            agent: {
              prompt_template: "Produce the diff",
              acceptance: "a rendered diff exists",
              budget: { max_turns: 15 },
            },
            on_fail: "pause",
          },
        ],
      } as FlowDefinition;
    }

    it("parks at waiting_agent with a comment naming what the step needs (no assignee)", async () => {
      const { issueId } = await seedIssue();
      const wakeups: unknown[] = [];
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
        queueAgentWakeup: async (issue, node) => {
          wakeups.push({ issueId: issue.id, nodeId: node.id });
        },
      });

      const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
      await started.execution;

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("waiting_agent");
      expect(state.flowNodeId).toBe("board_diff");
      expect(wakeups).toHaveLength(0); // no assignee agent -> no wakeup
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain("Produce the diff");
      expect(comments[0].body).toContain("a rendered diff exists");
      expect(comments[0].body).toContain("No assignee agent");
      expect(await activityActions(issueId)).toContain("flow.agent_step_pending");
    });

    it("queues a best-effort wakeup when the issue has an assignee agent", async () => {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "APEX" });
      const agentId = await seedAgent(companyId);
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "agent issue", assigneeAgentId: agentId });

      const wakeups: unknown[] = [];
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
        queueAgentWakeup: async (issue, node) => {
          wakeups.push({ issueId: issue.id, nodeId: node.id });
        },
      });

      const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
      await started.execution;

      expect((await flowState(issueId)).flowStatus).toBe("waiting_agent");
      expect(wakeups).toEqual([{ issueId, nodeId: "board_diff" }]);
    });

    it("a wakeup failure is classified but leaves the flow parked (not failed)", async () => {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "APEX" });
      const agentId = await seedAgent(companyId);
      const issueId = randomUUID();
      await db.insert(issues).values({ id: issueId, companyId, title: "agent issue", assigneeAgentId: agentId });

      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
        queueAgentWakeup: async () => {
          throw new Error("heartbeat unavailable");
        },
      });

      const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
      await started.execution;

      expect((await flowState(issueId)).flowStatus).toBe("waiting_agent");
    });
  });

  it("refuses to start a flow over an active one", async () => {
    const { issueId } = await seedIssue();
    const { runner } = fakeRunner({});
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(choreFlow()),
      nodeRunner: runner,
    });
    await db
      .update(issues)
      .set({ flowName: "noop-verify", flowNodeId: "run", flowStatus: "waiting_gate" })
      .where(eq(issues.id, issueId));

    await expect(coordinator.startFlow({ issueId, flowName: "noop-verify" })).rejects.toThrow(
      /active flow/,
    );
  });

  it("allows restarting after a terminal flow status", async () => {
    const { issueId } = await seedIssue();
    const { runner } = fakeRunner({
      "simple-test": [ok],
      "health generate_health_report": [ok],
    });
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(choreFlow()),
      nodeRunner: runner,
    });
    await db
      .update(issues)
      .set({ flowName: "noop-verify", flowNodeId: "verify", flowStatus: "failed" })
      .where(eq(issues.id, issueId));

    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await started.execution;
    expect((await flowState(issueId)).flowStatus).toBe("done");
  });

  it("a coordinator error mid-flow marks the flow failed with classification", async () => {
    const { issueId } = await seedIssue();
    const runner: FlowNodeRunner = {
      runWorkflow: async () => {
        throw new Error("apex CLI exploded");
      },
      runCheck: async () => ok,
    };
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(choreFlow()),
      nodeRunner: runner,
    });

    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await started.execution;

    const state = await flowState(issueId);
    expect(state.flowStatus).toBe("failed");
    expect(await activityActions(issueId)).toContain("flow.failed");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments.some((c) => c.body.includes("apex CLI exploded"))).toBe(true);
  });

  describe("sweep", () => {
    it("resumes running flows whose advancement stamp is stale", async () => {
      const { issueId } = await seedIssue();
      const { runner, calls } = fakeRunner({
        "simple-test": [ok],
        "health generate_health_report": [ok],
      });
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(choreFlow()),
        nodeRunner: runner,
      });
      // Simulate a flow whose loop died: running, but stamp far in the past.
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await db
        .update(issues)
        .set({
          flowName: "noop-verify",
          flowNodeId: "run",
          flowStatus: "running",
          flowStartedAt: past,
          flowAdvancedAt: past,
        })
        .where(eq(issues.id, issueId));

      const { resumed } = await coordinator.sweep(5 * 60_000);
      expect(resumed).toBe(1);
      expect((await flowState(issueId)).flowStatus).toBe("done");
      expect(calls.map((c) => c.kind)).toEqual(["workflow", "check"]);
      expect(await activityActions(issueId)).toContain("flow.sweep_resumed");
    });

    it("leaves fresh running flows alone", async () => {
      const { issueId } = await seedIssue();
      const { runner, calls } = fakeRunner({});
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(choreFlow()),
        nodeRunner: runner,
      });
      await db
        .update(issues)
        .set({
          flowName: "noop-verify",
          flowNodeId: "run",
          flowStatus: "running",
          flowStartedAt: new Date(),
          flowAdvancedAt: new Date(),
        })
        .where(eq(issues.id, issueId));

      const { resumed } = await coordinator.sweep(5 * 60_000);
      expect(resumed).toBe(0);
      expect(calls).toHaveLength(0);
      expect((await flowState(issueId)).flowStatus).toBe("running");
    });
  });
});
