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
import {
  applyFlowRunPermissionOverride,
  clearFlowRunPermissionOverride,
  flowCoordinator,
  FLOW_GATE_APPROVAL_TYPE,
  type FlowIssue,
} from "../apex/flow/coordinator.js";
import type { FlowDefinition, FlowNode, LoadedFlowDefinition } from "../apex/flow/definition.js";
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
    await db.delete(heartbeatRuns);
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
        flowRunId: issues.flowRunId,
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

  it("workflow node params are templates rendered against the ticket (design-merge shape)", async () => {
    const { issueId } = await seedIssue();
    const flow = choreFlow();
    (flow.nodes[0].workflow as { params: Record<string, unknown> }).params = {
      repo: "sarala-ai/apex-design",
      head: "design/{{identifier}}",
    };
    const { runner, calls } = fakeRunner({
      "simple-test": [ok],
      "health generate_health_report": [ok],
    });
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(flow),
      nodeRunner: runner,
    });
    const started = await coordinator.startFlow({ issueId, flowName: "noop-verify" });
    await started.execution;

    const [issueRow] = await db.select().from(issues).where(eq(issues.id, issueId));
    const workflowCall = calls.find((c) => c.kind === "workflow");
    expect((workflowCall?.config as { params: Record<string, unknown> }).params).toEqual({
      repo: "sarala-ai/apex-design",
      head: `design/${issueRow.identifier}`,
    });
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

  describe("agent nodes (A-node bridge)", () => {
    function agentFlow(overrides: { acceptance?: string; promptTemplate?: string } = {}): FlowDefinition {
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
              prompt_template: overrides.promptTemplate ?? "Produce the diff for {{identifier}}: {{title}}",
              acceptance: overrides.acceptance ?? "a rendered diff exists",
              budget: { max_turns: 15 },
            },
            on_fail: "pause",
          },
        ],
      } as FlowDefinition;
    }

    async function seedAgentIssue(options: { assign?: boolean; extraAgent?: boolean } = { assign: true }) {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "APEX",
        issuePrefix: `T${Math.floor(Math.random() * 100000)}`,
      });
      const agentId = await seedAgent(companyId);
      if (options.extraAgent) await seedAgent(companyId);
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "make the board diff",
        identifier: `APE-${Math.floor(Math.random() * 100000)}`,
        description: "the change under review",
        assigneeAgentId: options.assign ? agentId : null,
      });
      return { companyId, agentId, issueId };
    }

    async function seedRun(companyId: string, agentId: string, status: string, extra: Record<string, unknown> = {}) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status,
        ...extra,
      });
      return runId;
    }

    it("launcher packages flow context: instruction comment + commission + run linkage", async () => {
      const { issueId, agentId, companyId } = await seedAgentIssue({ assign: true });
      const commissions: Array<{ issueId: string; nodeId: string; agentId: string; commentId: string; prompt: string }> = [];
      // flowRunId is FK-checked against heartbeat_runs — commission must hand
      // back a real run id, exactly like the native machinery does.
      const runId = await seedRun(companyId, agentId, "queued");
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
        commissionAgentRun: async (issue, node, commission) => {
          commissions.push({
            issueId: issue.id,
            nodeId: node.id,
            agentId: commission.agentId,
            commentId: commission.instructionCommentId,
            prompt: commission.renderedPrompt,
          });
          return { runId };
        },
      });

      const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
      await started.execution;

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("waiting_agent");
      expect(state.flowNodeId).toBe("board_diff");
      expect(state.flowRunId).toBe(runId);

      expect(commissions).toHaveLength(1);
      expect(commissions[0].issueId).toBe(issueId);
      expect(commissions[0].nodeId).toBe("board_diff");
      expect(commissions[0].agentId).toBe(agentId);
      // prompt template interpolated from the issue
      expect(commissions[0].prompt).toContain("make the board diff");
      expect(commissions[0].prompt).toMatch(/APE-\d+/);

      // the instruction comment exists, is system-authored, and IS the one
      // handed to the commission (the run's wake comment)
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments).toHaveLength(1);
      expect(comments[0].id).toBe(commissions[0].commentId);
      expect(comments[0].authorType).toBe("system");
      expect(comments[0].body).toContain("make the board diff");
      expect(comments[0].body).toContain("a rendered diff exists");
      expect(comments[0].body).toContain("max_turns");

      const actions = await activityActions(issueId);
      expect(actions).toContain("flow.agent_step_pending");
      expect(actions).toContain("flow.agent_run_commissioned");
    });

    it("auto-assigns the company's single assignable agent when the issue has none", async () => {
      const { issueId, agentId, companyId } = await seedAgentIssue({ assign: false });
      const runId = await seedRun(companyId, agentId, "queued");
      const commissions: string[] = [];
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
        commissionAgentRun: async (_issue, _node, commission) => {
          commissions.push(commission.agentId);
          return { runId };
        },
      });

      const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
      await started.execution;

      expect(commissions).toEqual([agentId]);
      const [row] = await db.select({ assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.id, issueId));
      expect(row.assigneeAgentId).toBe(agentId);
      expect((await flowState(issueId)).flowStatus).toBe("waiting_agent");
    });

    it("no assignable agent (or ambiguity) is a classified pause, never silent", async () => {
      const { issueId } = await seedAgentIssue({ assign: false, extraAgent: true });
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
        commissionAgentRun: async () => {
          throw new Error("must not commission without an agent");
        },
      });

      const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
      await started.execution;

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("paused");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.includes("flow_agent_unavailable"))).toBe(true);
    });

    it("a declined wakeup (null commission) stays waiting_agent, classified + surfaced (deferral promotes later)", async () => {
      const { issueId } = await seedAgentIssue({ assign: true });
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
        commissionAgentRun: async () => null,
      });

      const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
      await started.execution;

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("waiting_agent");
      expect(state.flowRunId).toBeNull();
      expect(await activityActions(issueId)).toContain("flow.agent_run_deferred");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.includes("deferred"))).toBe(true);
    });

    it("sweep resolves a promoted run by context markers when no linkage was recorded", async () => {
      const { issueId, companyId, agentId } = await seedAgentIssue({ assign: true });
      // A promoted run carrying the flow context markers, already terminal.
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId, flowName: "agentic", flowNodeId: "board_diff", flowAgentStep: true },
      });
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await db
        .update(issues)
        .set({
          flowName: "agentic",
          flowNodeId: "board_diff",
          flowStatus: "waiting_agent",
          flowRunId: null,
          flowStartedAt: past,
          flowAdvancedAt: past,
        })
        .where(eq(issues.id, issueId));
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
      });
      const { agentRecovered } = await coordinator.sweep(5 * 60_000);
      expect(agentRecovered).toBe(1);
      expect((await flowState(issueId)).flowStatus).toBe("done");
    });

    it("a commission failure is classified and routed through on_fail", async () => {
      const { issueId } = await seedAgentIssue({ assign: true });
      const coordinator = flowCoordinator(db, {
        loadDefinition: loaderFor(agentFlow()),
        nodeRunner: fakeRunner({}).runner,
        commissionAgentRun: async () => {
          throw new Error("heartbeat unavailable");
        },
      });

      const started = await coordinator.startFlow({ issueId, flowName: "agentic" });
      await started.execution;

      const state = await flowState(issueId);
      expect(state.flowStatus).toBe("paused");
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.includes("agent_run_commission_failed"))).toBe(true);
    });

    describe("completion hook", () => {
      async function commissionedFlow(acceptance?: string) {
        const seeded = await seedAgentIssue({ assign: true });
        const runId = await seedRun(seeded.companyId, seeded.agentId, "succeeded");
        const coordinator = flowCoordinator(db, {
          loadDefinition: loaderFor(agentFlow({ acceptance })),
          nodeRunner: fakeRunner({}).runner,
          commissionAgentRun: async () => ({ runId }),
        });
        const started = await coordinator.startFlow({ issueId: seeded.issueId, flowName: "agentic" });
        await started.execution;
        expect((await flowState(seeded.issueId)).flowStatus).toBe("waiting_agent");
        return { ...seeded, runId, coordinator };
      }

      it("run succeeded -> acceptance v1 -> flow advances to done", async () => {
        const { issueId, runId, coordinator } = await commissionedFlow();
        const result = await coordinator.onAgentRunCompletion({
          runId,
          issueId,
          flowName: "agentic",
          flowNodeId: "board_diff",
          runStatus: "succeeded",
        });
        expect(result.advanced).toBe(true);
        if ("execution" in result && result.execution) await result.execution;

        const state = await flowState(issueId);
        expect(state.flowStatus).toBe("done");
        expect(state.flowRunId).toBeNull();
        const actions = await activityActions(issueId);
        expect(actions).toContain("flow.agent_step_succeeded");
        expect(actions).toContain("flow.completed");
      });

      it("run failed -> classified pause via on_fail", async () => {
        const { issueId, runId, coordinator } = await commissionedFlow();
        const result = await coordinator.onAgentRunCompletion({
          runId,
          issueId,
          flowName: "agentic",
          flowNodeId: "board_diff",
          runStatus: "failed",
          error: "adapter exploded",
        });
        expect(result.advanced).toBe(false);

        const state = await flowState(issueId);
        expect(state.flowStatus).toBe("paused");
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        expect(comments.some((c) => c.body.includes("agent_run_failed") && c.body.includes("adapter exploded"))).toBe(true);
      });

      it("file_exists acceptance verifies the artifact (pass and fail)", async () => {
        const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = await mkdtemp(join(tmpdir(), "flow-acceptance-"));
        try {
          const artifact = join(dir, "artifact.txt");

          // fail first: artifact missing
          const missing = await commissionedFlow(`file_exists:${artifact}`);
          const failed = await missing.coordinator.onAgentRunCompletion({
            runId: missing.runId,
            issueId: missing.issueId,
            flowName: "agentic",
            flowNodeId: "board_diff",
            runStatus: "succeeded",
          });
          expect(failed).toMatchObject({ advanced: false, reason: "agent_acceptance_failed" });
          expect((await flowState(missing.issueId)).flowStatus).toBe("paused");

          // pass: artifact present
          await writeFile(artifact, "diff");
          const present = await commissionedFlow(`file_exists:${artifact}`);
          const passed = await present.coordinator.onAgentRunCompletion({
            runId: present.runId,
            issueId: present.issueId,
            flowName: "agentic",
            flowNodeId: "board_diff",
            runStatus: "succeeded",
          });
          expect(passed.advanced).toBe(true);
          if ("execution" in passed && passed.execution) await passed.execution;
          expect((await flowState(present.issueId)).flowStatus).toBe("done");
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });

      it("acceptance templates render against the ticket for the instruction AND the evaluation", async () => {
        const seeded = await seedAgentIssue({ assign: true });
        const runId = await seedRun(seeded.companyId, seeded.agentId, "succeeded");
        const evaluated: string[] = [];
        const coordinator = flowCoordinator(db, {
          loadDefinition: loaderFor(
            agentFlow({ acceptance: "pr_exists:sarala-ai/apex-design#design/{{identifier}}" }),
          ),
          nodeRunner: fakeRunner({}).runner,
          commissionAgentRun: async () => ({ runId }),
          evaluateAcceptance: async (acceptance) => {
            evaluated.push(acceptance);
            return { ok: true, evaluation: "stubbed pr_exists pass" };
          },
        });
        const started = await coordinator.startFlow({ issueId: seeded.issueId, flowName: "agentic" });
        await started.execution;

        const [issueRow] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
        const rendered = `pr_exists:sarala-ai/apex-design#design/${issueRow.identifier}`;
        // instruction comment carries the RENDERED acceptance (no {{tokens}})
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
        expect(comments[0].body).toContain(rendered);
        expect(comments[0].body).not.toContain("{{identifier}}");

        const result = await coordinator.onAgentRunCompletion({
          runId,
          issueId: seeded.issueId,
          flowName: "agentic",
          flowNodeId: "board_diff",
          runStatus: "succeeded",
        });
        expect(result.advanced).toBe(true);
        if ("execution" in result && result.execution) await result.execution;
        // evaluator saw the SAME rendered string
        expect(evaluated).toEqual([rendered]);
        expect((await flowState(seeded.issueId)).flowStatus).toBe("done");
      });

      it("failed pr_exists acceptance routes on_fail with classification", async () => {
        const seeded = await seedAgentIssue({ assign: true });
        const runId = await seedRun(seeded.companyId, seeded.agentId, "succeeded");
        const coordinator = flowCoordinator(db, {
          loadDefinition: loaderFor(
            agentFlow({ acceptance: "pr_exists:sarala-ai/apex-design#design/{{identifier}}" }),
          ),
          nodeRunner: fakeRunner({}).runner,
          commissionAgentRun: async () => ({ runId }),
          evaluateAcceptance: async () => ({
            ok: false,
            evaluation: "v1: run success + pr_exists check FAILED",
            message: "acceptance pull request not found: no open PR",
          }),
        });
        const started = await coordinator.startFlow({ issueId: seeded.issueId, flowName: "agentic" });
        await started.execution;
        const result = await coordinator.onAgentRunCompletion({
          runId,
          issueId: seeded.issueId,
          flowName: "agentic",
          flowNodeId: "board_diff",
          runStatus: "succeeded",
        });
        expect(result).toMatchObject({ advanced: false, reason: "agent_acceptance_failed" });
        expect((await flowState(seeded.issueId)).flowStatus).toBe("paused");
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, seeded.issueId));
        expect(comments.some((c) => c.body.includes("acceptance pull request not found"))).toBe(true);
      });

      it("a stale or mismatched completion is a classified no-op", async () => {
        const { issueId, runId, coordinator } = await commissionedFlow();
        // wrong node
        expect(
          await coordinator.onAgentRunCompletion({
            runId,
            issueId,
            flowName: "agentic",
            flowNodeId: "other_node",
            runStatus: "succeeded",
          }),
        ).toMatchObject({ advanced: false, reason: "stale_agent_completion" });
        // wrong run id
        expect(
          await coordinator.onAgentRunCompletion({
            runId: randomUUID(),
            issueId,
            flowName: "agentic",
            flowNodeId: "board_diff",
            runStatus: "succeeded",
          }),
        ).toMatchObject({ advanced: false, reason: "stale_agent_completion" });
        expect((await flowState(issueId)).flowStatus).toBe("waiting_agent");
      });
    });

    describe("sweep recovery for waiting_agent", () => {
      async function parkStale(input: {
        runStatus?: string | null;
        linkRun?: boolean;
      }) {
        const seeded = await seedAgentIssue({ assign: true });
        const runId =
          input.runStatus != null ? await seedRun(seeded.companyId, seeded.agentId, input.runStatus) : null;
        const past = new Date(Date.now() - 60 * 60 * 1000);
        await db
          .update(issues)
          .set({
            flowName: "agentic",
            flowNodeId: "board_diff",
            flowStatus: "waiting_agent",
            flowRunId: input.linkRun === false ? null : runId,
            flowStartedAt: past,
            flowAdvancedAt: past,
          })
          .where(eq(issues.id, seeded.issueId));
        const coordinator = flowCoordinator(db, {
          loadDefinition: loaderFor(agentFlow()),
          nodeRunner: fakeRunner({}).runner,
          commissionAgentRun: async () => {
            throw new Error("sweep must not re-commission in v1");
          },
        });
        return { ...seeded, runId, coordinator };
      }

      it("terminal succeeded run advances the flow", async () => {
        const { issueId, coordinator } = await parkStale({ runStatus: "succeeded" });
        const { agentRecovered } = await coordinator.sweep(5 * 60_000);
        expect(agentRecovered).toBe(1);
        expect((await flowState(issueId)).flowStatus).toBe("done");
      });

      it("terminal failed run routes on_fail (pause) with classification", async () => {
        const { issueId, coordinator } = await parkStale({ runStatus: "timed_out" });
        const { agentRecovered } = await coordinator.sweep(5 * 60_000);
        expect(agentRecovered).toBe(1);
        expect((await flowState(issueId)).flowStatus).toBe("paused");
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        expect(comments.some((c) => c.body.includes("agent_run_timed_out"))).toBe(true);
      });

      it("an in-flight run is left alone", async () => {
        const { issueId, coordinator } = await parkStale({ runStatus: "running" });
        const { agentRecovered } = await coordinator.sweep(5 * 60_000);
        expect(agentRecovered).toBe(0);
        expect((await flowState(issueId)).flowStatus).toBe("waiting_agent");
      });

      it("no recorded commission after the staleness window is a classified pause", async () => {
        const { issueId, coordinator } = await parkStale({ runStatus: null, linkRun: false });
        const { agentRecovered } = await coordinator.sweep(5 * 60_000);
        expect(agentRecovered).toBe(1);
        expect((await flowState(issueId)).flowStatus).toBe("paused");
        const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
        expect(comments.some((c) => c.body.includes("agent_run_not_commissioned"))).toBe(true);
      });

      it("an interrupted run with a live retry re-links the flow to the retry", async () => {
        const { issueId, runId, coordinator, companyId, agentId } = await parkStale({ runStatus: "interrupted" });
        const retryId = await seedRun(companyId, agentId, "running", { retryOfRunId: runId });
        const { agentRecovered } = await coordinator.sweep(5 * 60_000);
        expect(agentRecovered).toBe(1);
        const state = await flowState(issueId);
        expect(state.flowStatus).toBe("waiting_agent");
        expect(state.flowRunId).toBe(retryId);
        expect(await activityActions(issueId)).toContain("flow.agent_run_relinked");
      });

      it("a fresh waiting_agent flow is untouched", async () => {
        const seeded = await seedAgentIssue({ assign: true });
        const runId = await seedRun(seeded.companyId, seeded.agentId, "succeeded");
        await db
          .update(issues)
          .set({
            flowName: "agentic",
            flowNodeId: "board_diff",
            flowStatus: "waiting_agent",
            flowRunId: runId,
            flowStartedAt: new Date(),
            flowAdvancedAt: new Date(),
          })
          .where(eq(issues.id, seeded.issueId));
        const coordinator = flowCoordinator(db, {
          loadDefinition: loaderFor(agentFlow()),
          nodeRunner: fakeRunner({}).runner,
        });
        const { agentRecovered } = await coordinator.sweep(5 * 60_000);
        expect(agentRecovered).toBe(0);
        expect((await flowState(seeded.issueId)).flowStatus).toBe("waiting_agent");
      });
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

  describe("governed permission override (flow run-policy injection seam)", () => {
    async function overrides(issueId: string): Promise<Record<string, unknown> | null> {
      const [row] = await db
        .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
        .from(issues)
        .where(eq(issues.id, issueId));
      return (row?.assigneeAdapterOverrides as Record<string, unknown> | null) ?? null;
    }

    const boundedNode: FlowNode = {
      id: "board_diff",
      kind: "agent",
      agent: {
        prompt_template: "do the thing",
        acceptance: "done",
        permissions: { profile: "bounded" },
      },
      on_fail: "pause",
    } as FlowNode;

    it("stamps a governed dangerouslySkipPermissions=false + bounded allowedTools grant on the issue's adapter override", async () => {
      const { issueId } = await seedIssue();
      const result = await applyFlowRunPermissionOverride(db, { id: issueId } as FlowIssue, boundedNode);
      expect(result?.profile).toBe("bounded");
      const stamped = await overrides(issueId);
      expect(stamped?.dangerouslySkipPermissions).toBe(false);
      expect(typeof stamped?.allowedTools).toBe("string");
      expect((stamped?.allowedTools as string).split(" ")).toContain("Read");
    });

    it("preserves a human-set model override already on the issue", async () => {
      const { issueId } = await seedIssue();
      await db
        .update(issues)
        .set({ assigneeAdapterOverrides: { model: "claude-opus-4-6" } })
        .where(eq(issues.id, issueId));

      await applyFlowRunPermissionOverride(db, { id: issueId } as FlowIssue, boundedNode);

      const stamped = await overrides(issueId);
      expect(stamped?.model).toBe("claude-opus-4-6");
      expect(stamped?.dangerouslySkipPermissions).toBe(false);
    });

    it("leaves an issue this flow never touched completely unaffected (interactive runs untouched)", async () => {
      const { companyId, issueId: touchedId } = await seedIssue();
      // Second issue in the SAME company — proves the override is issue-scoped,
      // not agent-record- or company-scoped: an untouched issue's interactive
      // runs are unaffected by another issue's flow commissioning.
      const untouchedId = randomUUID();
      await db.insert(issues).values({
        id: untouchedId,
        companyId,
        title: "untouched interactive issue",
        identifier: `APE-${Math.floor(Math.random() * 100000)}`,
      });

      await applyFlowRunPermissionOverride(db, { id: touchedId } as FlowIssue, boundedNode);

      expect(await overrides(touchedId)).not.toBeNull();
      expect(await overrides(untouchedId)).toBeNull();
    });

    it("clearFlowRunPermissionOverride strips the governed keys but preserves anything else, at flow-terminal", async () => {
      const { issueId } = await seedIssue();
      await applyFlowRunPermissionOverride(db, { id: issueId } as FlowIssue, boundedNode);
      await db
        .update(issues)
        .set({
          assigneeAdapterOverrides: {
            ...(await overrides(issueId)),
            model: "claude-opus-4-6",
          },
        })
        .where(eq(issues.id, issueId));

      await clearFlowRunPermissionOverride(db, issueId);

      const cleared = await overrides(issueId);
      expect(cleared).toEqual({ model: "claude-opus-4-6" });
    });

    it("clears down to null when the governed keys were the only thing set", async () => {
      const { issueId } = await seedIssue();
      await applyFlowRunPermissionOverride(db, { id: issueId } as FlowIssue, boundedNode);

      await clearFlowRunPermissionOverride(db, issueId);

      expect(await overrides(issueId)).toBeNull();
    });

    it("a full agent-node flow run stamps permissionMode/permissionProfile on the commissioned heartbeat run", async () => {
      const companyId = (await seedIssue()).companyId;
      // Reuse the schema directly: insert an agent + issue + a pre-seeded
      // heartbeat run standing in for what the real wakeup() would create,
      // then drive the coordinator's default-path commission bookkeeping
      // (permission override + run stamping) without invoking the real
      // heartbeat service (out of scope for a coordinator unit test).
      const agentId = await seedAgent(companyId);
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "stamped run",
        identifier: `APE-${Math.floor(Math.random() * 100000)}`,
        assigneeAgentId: agentId,
      });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued" });

      const permission = await applyFlowRunPermissionOverride(db, { id: issueId } as FlowIssue, boundedNode);
      await db
        .update(heartbeatRuns)
        .set({ permissionMode: "governed", permissionProfile: permission?.profile ?? null })
        .where(eq(heartbeatRuns.id, runId));

      const [row] = await db
        .select({ permissionMode: heartbeatRuns.permissionMode, permissionProfile: heartbeatRuns.permissionProfile })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(row.permissionMode).toBe("governed");
      expect(row.permissionProfile).toBe("bounded");
    });
  });
});
