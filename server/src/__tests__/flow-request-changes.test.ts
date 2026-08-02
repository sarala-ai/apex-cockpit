/**
 * `request_changes` at a flow gate — the backward transition.
 *
 * Approve advanced; there was no way to send work back. `retryCurrentNode` at
 * a gate re-arms the GATE, which only reopens the same question over the same
 * unchanged artifact. These tests cover the transition that closes that gap,
 * in the vocabulary pipeline review stages already use (approve / reject /
 * request_changes, reason required, named destination).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
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
import { flowCoordinator, FLOW_CHANGES_REQUESTED_ACTION } from "../apex/flow/coordinator.js";
import { noopFlowProjection, type FlowProjectionHooks } from "../apex/flow/github-projection.js";
import { findChangeRequestTarget, type FlowDefinition, type LoadedFlowDefinition } from "../apex/flow/definition.js";
import type { FlowNodeRunner, NodeExecutionResult } from "../apex/steps/runner.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

const ok: NodeExecutionResult = { ok: true, detail: { status: "success" } };

function agentNode(id: string) {
  return {
    id,
    kind: "agent" as const,
    agent: { prompt_template: `Do ${id} for {{identifier}}`, acceptance: "work exists", budget: null },
    on_fail: "pause" as const,
  };
}

/** feature.yml shaped: authoring agent -> automatic check -> gate. */
function checkedFlow(gateExtras: Record<string, unknown> = {}): FlowDefinition {
  return {
    name: "checked",
    version: "1.0",
    description: "author, verify, gate",
    ticket_type: "feature",
    nodes: [
      agentNode("tasks"),
      {
        id: "task_checks",
        kind: "check",
        check: { tool: "lint run", args: [], pass_criteria: "exit_code == 0" },
        on_fail: "pause",
      },
      {
        id: "diff_gate",
        kind: "gate",
        gate: { mode: "approve", prompt: "Check the diff", ...gateExtras },
        on_fail: "pause",
      },
    ],
  } as FlowDefinition;
}

/** feature.yml's `promote`: a gate at index 0, nothing before it. */
function gateFirstFlow(): FlowDefinition {
  return {
    name: "promote-first",
    version: "1.0",
    description: "gate then work",
    ticket_type: "feature",
    nodes: [
      { id: "promote", kind: "gate", gate: { mode: "approve", prompt: "Promote?" }, on_fail: "pause" },
      agentNode("spec"),
    ],
  } as FlowDefinition;
}

/** Two authoring steps before one gate — proves "nearest prior", not "first". */
function twoAuthorsFlow(gateExtras: Record<string, unknown> = {}): FlowDefinition {
  return {
    name: "two-authors",
    version: "1.0",
    description: "spec, design, gate",
    ticket_type: "feature",
    nodes: [
      agentNode("spec"),
      agentNode("design"),
      { id: "gate", kind: "gate", gate: { mode: "approve", prompt: "Check", ...gateExtras }, on_fail: "pause" },
    ],
  } as FlowDefinition;
}

function loaderFor(flow: FlowDefinition) {
  return async (name: string): Promise<LoadedFlowDefinition> => {
    if (name !== flow.name) throw new Error(`unexpected flow name ${name}`);
    return { path: `/fake/${name}.yml`, flow, reviewPasses: {} };
  };
}

describe("findChangeRequestTarget — the routing rule", () => {
  it("derives the NEAREST prior agent node, not the first", () => {
    const target = findChangeRequestTarget(twoAuthorsFlow(), "gate");
    expect(target).toMatchObject({ found: true, source: "derived", index: 1 });
    if (target.found) expect(target.node.id).toBe("design");
  });

  it("skips over check and workflow nodes to reach the authoring step", () => {
    const target = findChangeRequestTarget(checkedFlow(), "diff_gate");
    expect(target).toMatchObject({ found: true, source: "derived" });
    if (target.found) expect(target.node.id).toBe("tasks");
  });

  it("a declared request_changes_to wins over the derived nearest", () => {
    const target = findChangeRequestTarget(twoAuthorsFlow({ request_changes_to: "spec" }), "gate");
    expect(target).toMatchObject({ found: true, source: "declared" });
    if (target.found) expect(target.node.id).toBe("spec");
  });

  it("a declared target that does not exist is classified, never a silent fallback", () => {
    expect(findChangeRequestTarget(twoAuthorsFlow({ request_changes_to: "ghost" }), "gate")).toEqual({
      found: false,
      reason: "declared_target_missing",
    });
  });

  it("a declared target that is not an agent node is classified", () => {
    expect(findChangeRequestTarget(checkedFlow({ request_changes_to: "task_checks" }), "diff_gate")).toEqual({
      found: false,
      reason: "declared_target_not_agent",
    });
  });

  it("a gate with no agent step before it has no target", () => {
    expect(findChangeRequestTarget(gateFirstFlow(), "promote")).toEqual({
      found: false,
      reason: "no_prior_agent_node",
    });
  });
});

describeEmbeddedPostgres("request_changes at a flow gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-flow-request-changes-");
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

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "APEX" });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "worker" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "gate rework",
      identifier: `APE-${Math.floor(Math.random() * 100000)}`,
      assigneeAgentId: agentId,
    });
    return { companyId, issueId, agentId };
  }

  type Harness = {
    coordinator: ReturnType<typeof flowCoordinator>;
    commissions: Array<{ nodeId: string; agentId: string; commentId: string }>;
    checkRuns: string[];
    projected: Array<Record<string, unknown>>;
  };

  function harness(
    flow: FlowDefinition,
    options: { commissionReturnsNull?: boolean } = {},
  ): Harness {
    const commissions: Harness["commissions"] = [];
    const checkRuns: string[] = [];
    const projected: Harness["projected"] = [];
    const runner: FlowNodeRunner = {
      runWorkflow: async () => ok,
      runCheck: async (config) => {
        checkRuns.push(config.tool);
        return ok;
      },
    };
    const projection: FlowProjectionHooks = {
      ...noopFlowProjection,
      changesRequested: async (event) => {
        projected.push({ ...event });
      },
    };
    const coordinator = flowCoordinator(db, {
      loadDefinition: loaderFor(flow),
      nodeRunner: runner,
      projection,
      evaluateAcceptance: async () => ({ ok: true, evaluation: "test: accepted" }),
      commissionAgentRun: async (issue, node, commission) => {
        commissions.push({
          nodeId: node.id,
          agentId: commission.agentId,
          commentId: commission.instructionCommentId,
        });
        if (options.commissionReturnsNull) return null;
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
    return { coordinator, commissions, checkRuns, projected };
  }

  /** Drive a flow from start to its gate, completing every agent node. */
  async function driveToGate(h: Harness, issueId: string, flowName: string) {
    const started = await h.coordinator.startFlow({ issueId, flowName });
    await started.execution;
    await settleAgentSteps(h, issueId, flowName);
  }

  async function settleAgentSteps(h: Harness, issueId: string, flowName: string) {
    for (let guard = 0; guard < 10; guard += 1) {
      const [row] = await db
        .select({ flowStatus: issues.flowStatus, flowNodeId: issues.flowNodeId, flowRunId: issues.flowRunId })
        .from(issues)
        .where(eq(issues.id, issueId));
      if (row.flowStatus !== "waiting_agent" || !row.flowRunId) return;
      const result = await h.coordinator.onAgentRunCompletion({
        runId: row.flowRunId,
        issueId,
        flowName,
        flowNodeId: row.flowNodeId,
        runStatus: "succeeded",
      });
      if (result.execution) await result.execution;
    }
    throw new Error("flow did not settle");
  }

  async function pendingApproval() {
    const rows = await db.select().from(approvals).orderBy(asc(approvals.createdAt));
    return rows.find((row) => row.status === "pending") ?? null;
  }

  /** What the route does before handing the decision to the coordinator:
   *  resolve the approval first, so the decided one can never be picked up
   *  again as the gate's pending question. */
  async function resolveApprovalAs(id: string, status: "revision_requested" | "rejected" | "approved") {
    await db
      .update(approvals)
      .set({ status, decidedByUserId: "founder", decidedAt: new Date() })
      .where(eq(approvals.id, id));
  }

  async function commentBodies(issueId: string) {
    const rows = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(asc(issueComments.createdAt));
    return rows.map((row) => row.body);
  }

  async function actions(issueId: string) {
    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .orderBy(asc(activityLog.createdAt));
    return rows;
  }

  it("re-arms the AUTHORING node, not the gate, and the intermediate check re-runs", async () => {
    const { issueId } = await seed();
    const h = harness(checkedFlow());
    await driveToGate(h, issueId, "checked");

    expect((await db.select({ s: issues.flowStatus }).from(issues).where(eq(issues.id, issueId)))[0].s)
      .toBe("waiting_gate");
    expect(h.checkRuns).toEqual(["lint run"]);
    const first = await pendingApproval();
    expect(first).not.toBeNull();

    await resolveApprovalAs(first!.id, "revision_requested");
    const decision = await h.coordinator.onGateDecision({
      approvalId: first!.id,
      payload: first!.payload,
      decision: "request_changes",
      decidedByUserId: "founder",
      reason: "The migration is missing a down step.",
    });
    expect(decision).toMatchObject({ resumed: true, reason: "changes_requested", targetNodeId: "tasks", round: 1 });
    if (decision.resumed) await decision.execution;

    // The flow went BACKWARD to the authoring node and commissioned it again.
    expect(h.commissions.map((c) => c.nodeId)).toEqual(["tasks", "tasks"]);
    await settleAgentSteps(h, issueId, "checked");

    // The check between the authoring node and the gate ran again on the way
    // forward — the gate never reopens on unverified work.
    expect(h.checkRuns).toEqual(["lint run", "lint run"]);
    const [state] = await db
      .select({ flowStatus: issues.flowStatus, flowNodeId: issues.flowNodeId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(state).toMatchObject({ flowStatus: "waiting_gate", flowNodeId: "diff_gate" });
  });

  it("returns to the gate with a NEW pending approval; the decided one stays as the audit record", async () => {
    const { issueId } = await seed();
    const h = harness(checkedFlow());
    await driveToGate(h, issueId, "checked");
    const first = await pendingApproval();

    await resolveApprovalAs(first!.id, "revision_requested");
    const decision = await h.coordinator.onGateDecision({
      approvalId: first!.id,
      payload: first!.payload,
      decision: "request_changes",
      decidedByUserId: "founder",
      reason: "Needs a down step.",
    });
    if (decision.resumed) await decision.execution;
    await settleAgentSteps(h, issueId, "checked");

    const all = await db.select().from(approvals);
    expect(all).toHaveLength(2);
    const fresh = await pendingApproval();
    expect(fresh!.id).not.toBe(first!.id);
    // Exactly one pending approval at any time — no stale gate lingering.
    expect(all.filter((row) => row.status === "pending")).toHaveLength(1);
    // Both are linked to the issue, so the round history is readable.
    const links = await db.select().from(issueApprovals).where(eq(issueApprovals.issueId, issueId));
    expect(links).toHaveLength(2);
  });

  it("the reviewer's reason reaches the re-commissioned agent's instruction verbatim", async () => {
    const { issueId } = await seed();
    const h = harness(checkedFlow());
    await driveToGate(h, issueId, "checked");
    const first = await pendingApproval();

    const reason = "Two things:\n- the copy says 'Submit', the ticket says 'Send'\n- no empty state";
    await resolveApprovalAs(first!.id, "revision_requested");
    const decision = await h.coordinator.onGateDecision({
      approvalId: first!.id,
      payload: first!.payload,
      decision: "request_changes",
      decidedByUserId: "founder",
      reason,
    });
    if (decision.resumed) await decision.execution;

    const instruction = (await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, h.commissions[1].commentId)))[0].body;
    expect(instruction).toContain("Review feedback — address this");
    // Verbatim: every line, unrewritten, unsummarised.
    expect(instruction).toContain(reason);
    expect(instruction).toContain("round 1");
    expect(instruction).toContain("diff_gate");
    // And the step's own instruction is still there — feedback is additive.
    expect(instruction).toContain("Do tasks for");
  });

  it("repeated rounds accumulate: earlier feedback stays binding and is labelled", async () => {
    const { issueId } = await seed();
    const h = harness(checkedFlow());
    await driveToGate(h, issueId, "checked");

    const reasons = ["Round one: fix the copy.", "Round two: now the spacing is wrong."];
    for (const reason of reasons) {
      const approval = await pendingApproval();
      await resolveApprovalAs(approval!.id, "revision_requested");
      const decision = await h.coordinator.onGateDecision({
        approvalId: approval!.id,
        payload: approval!.payload,
        decision: "request_changes",
        decidedByUserId: "founder",
        reason,
      });
      expect(decision.resumed).toBe(true);
      if (decision.resumed) await decision.execution;
      await settleAgentSteps(h, issueId, "checked");
    }

    const lastInstruction = (await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, h.commissions[2].commentId)))[0].body;
    // BOTH rounds present, newest first, earlier one explicitly still binding.
    expect(lastInstruction).toContain(reasons[0]);
    expect(lastInstruction).toContain(reasons[1]);
    expect(lastInstruction).toContain("Round 2 (latest)");
    expect(lastInstruction).toContain("STILL BINDING");
    expect(lastInstruction.indexOf(reasons[1])).toBeLessThan(lastInstruction.indexOf(reasons[0]));

    // Round numbering is recorded on the ledger, not inferred from timestamps.
    const rounds = (await actions(issueId))
      .filter((row) => row.action === FLOW_CHANGES_REQUESTED_ACTION)
      .map((row) => (row.details as Record<string, unknown>).round);
    expect(rounds).toEqual([1, 2]);
    expect(h.projected.map((event) => event.round)).toEqual([1, 2]);
    expect(h.projected[1]).toMatchObject({ targetNodeId: "tasks", reason: reasons[1] });
  });

  it("an approved gate closes its rounds: a later run of the same step carries no stale feedback", async () => {
    const { issueId } = await seed();
    const h = harness(checkedFlow());
    await driveToGate(h, issueId, "checked");

    const first = await pendingApproval();
    await resolveApprovalAs(first!.id, "revision_requested");
    const changes = await h.coordinator.onGateDecision({
      approvalId: first!.id,
      payload: first!.payload,
      decision: "request_changes",
      decidedByUserId: "founder",
      reason: "Stale-after-approval marker.",
    });
    if (changes.resumed) await changes.execution;
    await settleAgentSteps(h, issueId, "checked");

    const second = await pendingApproval();
    await resolveApprovalAs(second!.id, "approved");
    const approved = await h.coordinator.onGateDecision({
      approvalId: second!.id,
      payload: second!.payload,
      decision: "approve",
      decidedByUserId: "founder",
    });
    if (approved.resumed) await approved.execution;

    // Re-run the flow: the authoring step must not inherit the closed round.
    const restarted = await h.coordinator.startFlow({ issueId, flowName: "checked" });
    await restarted.execution;
    const reRun = (await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.id, h.commissions[h.commissions.length - 1].commentId)))[0].body;
    expect(reRun).not.toContain("Stale-after-approval marker.");
    expect(reRun).not.toContain("Review feedback — address this");
  });

  it("a declared request_changes_to routes to that node instead of the nearest", async () => {
    const { issueId } = await seed();
    const h = harness(twoAuthorsFlow({ request_changes_to: "spec" }));
    await driveToGate(h, issueId, "two-authors");
    const approval = await pendingApproval();
    await resolveApprovalAs(approval!.id, "revision_requested");

    const decision = await h.coordinator.onGateDecision({
      approvalId: approval!.id,
      payload: approval!.payload,
      decision: "request_changes",
      decidedByUserId: "founder",
      reason: "The spec itself is wrong, not the design.",
    });
    expect(decision).toMatchObject({ resumed: true, targetNodeId: "spec" });
    if (decision.resumed) await decision.execution;

    const [row] = await actions(issueId).then((rows) =>
      rows.filter((entry) => entry.action === FLOW_CHANGES_REQUESTED_ACTION),
    );
    expect(row.details).toMatchObject({ targetNodeId: "spec", targetSource: "declared" });
  });

  it("a gate with no prior agent node pauses and says why", async () => {
    const { issueId } = await seed();
    const h = harness(gateFirstFlow());
    const started = await h.coordinator.startFlow({ issueId, flowName: "promote-first" });
    await started.execution;
    const approval = await pendingApproval();

    const decision = await h.coordinator.onGateDecision({
      approvalId: approval!.id,
      payload: approval!.payload,
      decision: "request_changes",
      decidedByUserId: "founder",
      reason: "Not ready.",
    });
    expect(decision).toMatchObject({
      resumed: false,
      reason: "changes_request_blocked",
      blocked: "no_prior_agent_node",
    });

    const [state] = await db.select({ s: issues.flowStatus }).from(issues).where(eq(issues.id, issueId));
    expect(state.s).toBe("paused");
    // The surfaced message names the actual cause, not "restart or amend".
    const bodies = await commentBodies(issueId);
    expect(bodies.some((body) => body.includes("no agent step precedes this gate"))).toBe(true);
    // Nothing was commissioned.
    expect(h.commissions).toHaveLength(0);
  });

  it("a reasonless request_changes is blocked at the coordinator too, not just the route", async () => {
    const { issueId } = await seed();
    const h = harness(checkedFlow());
    await driveToGate(h, issueId, "checked");
    const approval = await pendingApproval();

    const decision = await h.coordinator.onGateDecision({
      approvalId: approval!.id,
      payload: approval!.payload,
      decision: "request_changes",
      decidedByUserId: "founder",
      reason: "   ",
    });
    expect(decision).toMatchObject({ resumed: false, blocked: "no_reason_given" });
    const [state] = await db.select({ s: issues.flowStatus }).from(issues).where(eq(issues.id, issueId));
    expect(state.s).toBe("paused");
  });

  it("does not double-commission when a run already holds the issue: the deferral guard applies", async () => {
    const { issueId } = await seed();
    // Commission declines exactly as heartbeat does when a run holds the lock.
    const h = harness(checkedFlow(), { commissionReturnsNull: true });
    const started = await h.coordinator.startFlow({ issueId, flowName: "checked" });
    await started.execution;

    expect(h.commissions).toHaveLength(1);
    const [state] = await db
      .select({ flowStatus: issues.flowStatus, flowRunId: issues.flowRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    // Parked awaiting the promoted wake — NOT paused, NOT commissioned twice.
    expect(state.flowStatus).toBe("waiting_agent");
    expect(state.flowRunId).toBeNull();
    expect((await actions(issueId)).map((row) => row.action)).toContain("flow.agent_run_deferred");
  });

  it("reject STOPS the flow — it is not another round", async () => {
    const { issueId } = await seed();
    const h = harness(checkedFlow());
    await driveToGate(h, issueId, "checked");
    const approval = await pendingApproval();
    const commissionsBefore = h.commissions.length;

    const decision = await h.coordinator.onGateDecision({
      approvalId: approval!.id,
      payload: approval!.payload,
      decision: "reject",
      decidedByUserId: "founder",
      reason: "This should not ship at all.",
    });
    expect(decision).toMatchObject({ resumed: false, reason: "rejected" });

    const [state] = await db
      .select({ flowStatus: issues.flowStatus, flowNodeId: issues.flowNodeId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(state).toMatchObject({ flowStatus: "paused", flowNodeId: "diff_gate" });
    expect(h.commissions).toHaveLength(commissionsBefore);
    const bodies = await commentBodies(issueId);
    expect(bodies.some((body) => body.includes("This should not ship at all."))).toBe(true);
    expect(bodies.some((body) => body.includes("request changes"))).toBe(true);
  });

  it("requestChangesFromGate rejects a call made when the flow is not at that gate", async () => {
    const { issueId } = await seed();
    const h = harness(checkedFlow());
    await driveToGate(h, issueId, "checked");

    await expect(
      h.coordinator.requestChangesFromGate(issueId, {
        gateNodeId: "not_this_gate",
        reason: "anything",
        decidedByUserId: "founder",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      h.coordinator.requestChangesFromGate(issueId, {
        gateNodeId: "diff_gate",
        reason: "  ",
        decidedByUserId: "founder",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
