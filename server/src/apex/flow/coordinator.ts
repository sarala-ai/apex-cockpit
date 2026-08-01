/**
 * Flow coordinator — "a state machine, not a brain"
 * (apex docs/architecture/work-loop.md).
 *
 * Deterministically advances an issue through a typed flow (W/C/A/G nodes,
 * implicit linear edges, per-node on_fail routing). All judgment lives in
 * the nodes' executors and the humans at gates; this module only moves the
 * pointer.
 *
 * Single-writer discipline: this coordinator is the ONLY thing that writes
 * the issues.flow* columns. Every write is an optimistic compare-and-set
 * against the (flowStatus, flowNodeId) it last read — a lost race is a
 * classified conflict, never a silent overwrite. Every transition stamps
 * flowAdvancedAt and lands a classified activity-log entry.
 *
 * Interruption is by exception, not by schedule: gates and failures surface
 * (approval / issue comment + activity); clean advancement is silent.
 *
 * Honest v1 boundaries (see also node-executors.ts):
 * - agent nodes do NOT fake an agent run. The fork's checkout/execution
 *   machinery (heartbeat.ts) creates its own heartbeat run inside the
 *   scheduler-adapter loop and needs more context than a flow node carries,
 *   so v1 parks the flow at `waiting_agent`, surfaces an issue comment
 *   naming exactly what the step needs, and (when the issue has an
 *   assignee agent) queues a best-effort wakeup. There is no automatic
 *   acceptance evaluation and no automatic resume for agent nodes.
 * - "inbox items" are an issue comment + activity-log entry. The fork's
 *   inbox is a computed read model (no insert API), so flow surfacing rides
 *   the primitives that feed it rather than pretending a feed exists.
 * - no fan-out: one flow per issue, nodes strictly sequential.
 */
import { eq, and, lt, isNull, or, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { approvalService } from "../../services/approvals.js";
import { issueApprovalService } from "../../services/issue-approvals.js";
import { issueService } from "../../services/issues.js";
import {
  loadFlowDefinition,
  type FlowDefinition,
  type FlowNode,
  type LoadedFlowDefinition,
} from "./definition.js";
import { CliFlowNodeRunner, type FlowNodeRunner } from "./node-executors.js";

export const FLOW_STATUSES = [
  "running",
  "waiting_gate",
  "waiting_agent",
  "paused",
  "done",
  "failed",
] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

/** Statuses in which a flow is still attached and a new one may not start. */
const ACTIVE_FLOW_STATUSES: FlowStatus[] = ["running", "waiting_gate", "waiting_agent", "paused"];

export const FLOW_GATE_APPROVAL_TYPE = "flow_gate";

/** The flow-state slice of an issue row this module reads and writes. */
type FlowIssue = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  assigneeAgentId: string | null;
  flowName: string | null;
  flowNodeId: string | null;
  flowStatus: string | null;
  flowStartedAt: Date | null;
  flowAdvancedAt: Date | null;
};

type NodeFailure = { errorType: string; message: string };

export type FlowCoordinatorDeps = {
  loadDefinition: (name: string) => Promise<LoadedFlowDefinition>;
  nodeRunner: FlowNodeRunner;
  /** Best-effort nudge for agent nodes when the issue has an assignee agent.
   *  Failures are classified and logged, never fatal to the flow. */
  queueAgentWakeup: (issue: FlowIssue, node: FlowNode) => Promise<void>;
  now: () => Date;
};

/** Raised when a compare-and-set on the flow columns matched no row — some
 *  other actor moved the state. Single-writer discipline makes this a bug
 *  worth surfacing loudly, not a case to paper over. */
export class FlowStateConflictError extends Error {
  constructor(issueId: string, expected: { flowStatus: string | null; flowNodeId: string | null }) {
    super(
      `flow state for issue ${issueId} changed underneath the coordinator ` +
        `(expected status=${expected.flowStatus} node=${expected.flowNodeId}) — ` +
        `single-writer discipline violated or a concurrent advance ran.`,
    );
    this.name = "FlowStateConflictError";
  }
}

async function defaultQueueAgentWakeup(db: Db, issue: FlowIssue, node: FlowNode): Promise<void> {
  if (!issue.assigneeAgentId) return;
  // Lazy import: heartbeat.ts is enormous and only needed on this path.
  const { heartbeatService } = await import("../../services/heartbeat.js");
  await heartbeatService(db).wakeup(issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "flow_agent_step",
    payload: { issueId: issue.id, flowName: issue.flowName, flowNodeId: node.id },
    contextSnapshot: {
      source: "flow.agent_step",
      issueId: issue.id,
      flowName: issue.flowName,
      flowNodeId: node.id,
      promptTemplate: node.agent?.prompt_template ?? null,
      acceptance: node.agent?.acceptance ?? null,
    },
  });
}

export function flowCoordinator(db: Db, overrides: Partial<FlowCoordinatorDeps> = {}) {
  const deps: FlowCoordinatorDeps = {
    loadDefinition: overrides.loadDefinition ?? loadFlowDefinition,
    nodeRunner: overrides.nodeRunner ?? new CliFlowNodeRunner(),
    queueAgentWakeup:
      overrides.queueAgentWakeup ?? ((issue, node) => defaultQueueAgentWakeup(db, issue, node)),
    now: overrides.now ?? (() => new Date()),
  };
  const issuesSvc = issueService(db);
  const approvalsSvc = approvalService(db);
  const issueApprovalsSvc = issueApprovalService(db);

  const FLOW_COLUMNS = {
    id: issues.id,
    companyId: issues.companyId,
    identifier: issues.identifier,
    title: issues.title,
    assigneeAgentId: issues.assigneeAgentId,
    flowName: issues.flowName,
    flowNodeId: issues.flowNodeId,
    flowStatus: issues.flowStatus,
    flowStartedAt: issues.flowStartedAt,
    flowAdvancedAt: issues.flowAdvancedAt,
  };

  async function getIssue(issueId: string): Promise<FlowIssue | null> {
    const rows = await db.select(FLOW_COLUMNS).from(issues).where(eq(issues.id, issueId));
    return (rows[0] as FlowIssue | undefined) ?? null;
  }

  /** Compare-and-set transition on the flow columns + classified activity log. */
  async function transition(
    issue: FlowIssue,
    patch: Partial<{ flowName: string | null; flowNodeId: string | null; flowStatus: FlowStatus | null }>,
    action: string,
    details: Record<string, unknown>,
  ): Promise<FlowIssue> {
    const stamp = deps.now();
    const updated = await db
      .update(issues)
      .set({ ...patch, flowAdvancedAt: stamp, updatedAt: stamp })
      .where(
        and(
          eq(issues.id, issue.id),
          issue.flowStatus === null ? isNull(issues.flowStatus) : eq(issues.flowStatus, issue.flowStatus),
          issue.flowNodeId === null ? isNull(issues.flowNodeId) : eq(issues.flowNodeId, issue.flowNodeId),
        ),
      )
      .returning(FLOW_COLUMNS);
    if (updated.length === 0) {
      throw new FlowStateConflictError(issue.id, {
        flowStatus: issue.flowStatus,
        flowNodeId: issue.flowNodeId,
      });
    }
    const next = updated[0] as FlowIssue;
    logger.info(
      { issueId: issue.id, flowName: next.flowName, flowNodeId: next.flowNodeId, flowStatus: next.flowStatus, action },
      `flow coordinator: ${action}`,
    );
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "flow-coordinator",
      action,
      entityType: "issue",
      entityId: issue.id,
      details: {
        flowName: next.flowName,
        flowNodeId: next.flowNodeId,
        flowStatus: next.flowStatus,
        flowAdvancedAt: stamp.toISOString(),
        ...details,
      },
    });
    return next;
  }

  /** Surface an exception to the human: issue comment (system-authored) +
   *  the activity entry the caller already logged. Never throws. */
  async function surface(issue: FlowIssue, body: string): Promise<void> {
    try {
      await issuesSvc.addComment(issue.id, body, {});
    } catch (err) {
      logger.error(
        { err, issueId: issue.id, flowName: issue.flowName },
        "flow coordinator: failed to surface issue comment (classified: surface_failed)",
      );
    }
  }

  function nodeIndex(flow: FlowDefinition, nodeId: string | null): number {
    return flow.nodes.findIndex((node) => node.id === nodeId);
  }

  async function markFailed(issue: FlowIssue, failure: NodeFailure): Promise<void> {
    const next = await transition(issue, { flowStatus: "failed" }, "flow.failed", {
      errorType: failure.errorType,
      error: failure.message,
    });
    await surface(
      next,
      `Flow **${next.flowName}** failed at node \`${next.flowNodeId}\` — ` +
        `[${failure.errorType}] ${failure.message}`,
    );
  }

  /** Advance past `index`: move the pointer or complete the flow.
   *  Returns the refreshed issue when the loop should continue, null when done. */
  async function advanceOrComplete(
    issue: FlowIssue,
    flow: FlowDefinition,
    index: number,
  ): Promise<FlowIssue | null> {
    const nextNode = flow.nodes[index + 1];
    if (!nextNode) {
      await transition(issue, { flowStatus: "done" }, "flow.completed", {
        completedNodeId: flow.nodes[index]?.id ?? null,
      });
      return null;
    }
    return transition(issue, { flowNodeId: nextNode.id }, "flow.advanced", {
      fromNodeId: flow.nodes[index]?.id ?? null,
      toNodeId: nextNode.id,
      toNodeKind: nextNode.kind,
    });
  }

  /** Apply a node's on_fail routing to a classified failure.
   *  Returns the refreshed issue when the loop should continue, null to stop. */
  async function applyOnFail(
    issue: FlowIssue,
    flow: FlowDefinition,
    index: number,
    failure: NodeFailure,
  ): Promise<FlowIssue | null> {
    const node = flow.nodes[index] as FlowNode;
    logger.warn(
      { issueId: issue.id, flowName: issue.flowName, nodeId: node.id, onFail: node.on_fail, ...failure },
      "flow coordinator: node failed",
    );
    if (node.on_fail === "skip") {
      const advanced = await transition(issue, {}, "flow.node_skipped", {
        nodeId: node.id,
        errorType: failure.errorType,
        error: failure.message,
      });
      return advanceOrComplete(advanced, flow, index);
    }
    if (node.on_fail.startsWith("jump:")) {
      const target = node.on_fail.slice("jump:".length);
      if (nodeIndex(flow, target) < 0) {
        // Core validates jump targets, but the definition may have changed
        // since the flow started — classify, don't crash.
        await markFailed(issue, {
          errorType: "flow_jump_target_missing",
          message: `on_fail jump target '${target}' no longer exists in flow '${flow.name}' (after: ${failure.message})`,
        });
        return null;
      }
      return transition(issue, { flowNodeId: target }, "flow.jumped", {
        fromNodeId: node.id,
        toNodeId: target,
        errorType: failure.errorType,
        error: failure.message,
      });
    }
    // pause (default)
    const paused = await transition(issue, { flowStatus: "paused" }, "flow.paused", {
      nodeId: node.id,
      errorType: failure.errorType,
      error: failure.message,
    });
    await surface(
      paused,
      `Flow **${flow.name}** paused at node \`${node.id}\` (${node.kind}) — ` +
        `[${failure.errorType}] ${failure.message}\n\n` +
        `Resolve the cause, then restart the flow (or decide the pending step) to continue.`,
    );
    return null;
  }

  async function executeGateNode(
    issue: FlowIssue,
    flow: FlowDefinition,
    index: number,
  ): Promise<FlowIssue | null> {
    const node = flow.nodes[index] as FlowNode;
    const gate = node.gate;
    if (!gate) {
      return applyOnFail(issue, flow, index, {
        errorType: "flow_node_config_missing",
        message: `gate node '${node.id}' carries no gate config`,
      });
    }
    if (gate.mode === "notify") {
      await surface(
        issue,
        `Flow **${flow.name}** passed notify gate \`${node.id}\`` +
          (gate.prompt ? ` — ${gate.prompt}` : "") +
          ` (auto-proceeding; reversible per work-loop doctrine).`,
      );
      const notified = await transition(issue, {}, "flow.gate_notified", {
        nodeId: node.id,
        prompt: gate.prompt ?? null,
      });
      return advanceOrComplete(notified, flow, index);
    }
    // approve mode: create the approval the founder decides, then park.
    const approval = await approvalsSvc.create(issue.companyId, {
      type: FLOW_GATE_APPROVAL_TYPE,
      status: "pending",
      payload: {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueTitle: issue.title,
        flowName: flow.name,
        nodeId: node.id,
        nodeIndex: index,
        totalNodes: flow.nodes.length,
        prompt: gate.prompt ?? null,
        ticketType: flow.ticket_type,
      },
    });
    await issueApprovalsSvc.link(issue.id, approval.id);
    await transition(issue, { flowStatus: "waiting_gate" }, "flow.gate_opened", {
      nodeId: node.id,
      approvalId: approval.id,
      prompt: gate.prompt ?? null,
    });
    return null;
  }

  async function executeAgentNode(
    issue: FlowIssue,
    flow: FlowDefinition,
    index: number,
  ): Promise<FlowIssue | null> {
    const node = flow.nodes[index] as FlowNode;
    const agent = node.agent;
    if (!agent) {
      return applyOnFail(issue, flow, index, {
        errorType: "flow_node_config_missing",
        message: `agent node '${node.id}' carries no agent config`,
      });
    }
    const waiting = await transition(issue, { flowStatus: "waiting_agent" }, "flow.agent_step_pending", {
      nodeId: node.id,
      acceptance: agent.acceptance,
      budget: agent.budget ?? null,
      assigneeAgentId: issue.assigneeAgentId,
    });
    // Honest placeholder — v1 does not drive a bounded agent run end-to-end.
    await surface(
      waiting,
      `Flow **${flow.name}** is waiting on agent step \`${node.id}\`.\n\n` +
        `This step needs a bounded agent run the coordinator does not drive yet (v1):\n` +
        `- prompt: ${agent.prompt_template.trim()}\n` +
        `- acceptance: ${agent.acceptance}\n` +
        (agent.budget ? `- budget: ${JSON.stringify(agent.budget)}\n` : "") +
        (waiting.assigneeAgentId
          ? `\nA wakeup was queued for the issue's assignee agent.`
          : `\nNo assignee agent on this issue — assign one and run the step, then advance the flow manually.`),
    );
    if (waiting.assigneeAgentId) {
      try {
        await deps.queueAgentWakeup(waiting, node);
      } catch (err) {
        logger.warn(
          { err, issueId: issue.id, nodeId: node.id },
          "flow coordinator: agent wakeup failed (classified: agent_wakeup_failed) — flow stays waiting_agent",
        );
      }
    }
    return null;
  }

  /** Drive the flow while it is `running`; parks/stops set a non-running
   *  status and return null from their step handler. */
  async function runLoop(issueId: string): Promise<void> {
    let issue = await getIssue(issueId);
    try {
      while (issue && issue.flowStatus === "running" && issue.flowName && issue.flowNodeId) {
        const { flow } = await deps.loadDefinition(issue.flowName);
        const index = nodeIndex(flow, issue.flowNodeId);
        if (index < 0) {
          await markFailed(issue, {
            errorType: "flow_node_missing",
            message: `current node '${issue.flowNodeId}' not found in flow '${issue.flowName}'`,
          });
          return;
        }
        const node = flow.nodes[index] as FlowNode;
        switch (node.kind) {
          case "workflow": {
            if (!node.workflow) {
              issue = await applyOnFail(issue, flow, index, {
                errorType: "flow_node_config_missing",
                message: `workflow node '${node.id}' carries no workflow config`,
              });
              break;
            }
            const result = await deps.nodeRunner.runWorkflow({
              workflow: node.workflow.workflow,
              params: node.workflow.params ?? {},
            });
            issue = result.ok
              ? await (async () => {
                  const done = await transition(issue as FlowIssue, {}, "flow.node_succeeded", {
                    nodeId: node.id,
                    kind: node.kind,
                    ...result.detail,
                  });
                  return advanceOrComplete(done, flow, index);
                })()
              : await applyOnFail(issue, flow, index, result);
            break;
          }
          case "check": {
            if (!node.check) {
              issue = await applyOnFail(issue, flow, index, {
                errorType: "flow_node_config_missing",
                message: `check node '${node.id}' carries no check config`,
              });
              break;
            }
            const result = await deps.nodeRunner.runCheck({
              tool: node.check.tool,
              args: node.check.args ?? [],
              pass_criteria: node.check.pass_criteria,
            });
            issue = result.ok
              ? await (async () => {
                  const done = await transition(issue as FlowIssue, {}, "flow.node_succeeded", {
                    nodeId: node.id,
                    kind: node.kind,
                    passCriteria: node.check?.pass_criteria,
                    passCriteriaEvaluation: "v1: CLI exit/status success only",
                    ...result.detail,
                  });
                  return advanceOrComplete(done, flow, index);
                })()
              : await applyOnFail(issue, flow, index, result);
            break;
          }
          case "gate":
            issue = await executeGateNode(issue, flow, index);
            break;
          case "agent":
            issue = await executeAgentNode(issue, flow, index);
            break;
        }
      }
    } catch (err) {
      if (err instanceof FlowStateConflictError) {
        // Another writer moved the state; abort this loop — the surviving
        // writer owns the flow now. Loud in logs, no state change from us.
        logger.error({ err, issueId }, "flow coordinator: state conflict — aborting advancement loop");
        return;
      }
      // Anything else (CLI missing, definition unloadable, DB failure): the
      // flow cannot honestly continue — classify and fail it.
      const fresh = await getIssue(issueId);
      const failure: NodeFailure = {
        errorType:
          err instanceof Error && "errorType" in err && typeof (err as { errorType?: unknown }).errorType === "string"
            ? (err as { errorType: string }).errorType
            : "flow_coordinator_error",
        message: err instanceof Error ? err.message : String(err),
      };
      logger.error({ err, issueId, ...failure }, "flow coordinator: advancement loop failed");
      if (fresh && fresh.flowStatus === "running") {
        try {
          await markFailed(fresh, failure);
        } catch (markErr) {
          logger.error({ err: markErr, issueId }, "flow coordinator: failed to mark flow failed");
        }
      }
    }
  }

  return {
    /** Attach a flow to an issue at node 0 and kick advancement.
     *  `execution` resolves when the loop parks or completes — callers that
     *  must not block (HTTP routes) fire-and-forget it; tests await it. */
    startFlow: async (input: { issueId: string; flowName: string }) => {
      const issue = await getIssue(input.issueId);
      if (!issue) throw notFound("Issue not found");
      if (issue.flowStatus && ACTIVE_FLOW_STATUSES.includes(issue.flowStatus as FlowStatus)) {
        throw conflict(
          `Issue already has an active flow (${issue.flowName} at ${issue.flowNodeId}, status ${issue.flowStatus}).`,
        );
      }
      const { flow } = await deps.loadDefinition(input.flowName);
      const firstNode = flow.nodes[0] as FlowNode;
      const stamp = deps.now();
      const started = await db
        .update(issues)
        .set({
          flowName: flow.name,
          flowNodeId: firstNode.id,
          flowStatus: "running",
          flowStartedAt: stamp,
          flowAdvancedAt: stamp,
          updatedAt: stamp,
        })
        .where(
          and(
            eq(issues.id, issue.id),
            or(isNull(issues.flowStatus), inArray(issues.flowStatus, ["done", "failed"])),
          ),
        )
        .returning(FLOW_COLUMNS);
      if (started.length === 0) {
        throw conflict("Issue flow state changed concurrently — start aborted.");
      }
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: "system",
        actorId: "flow-coordinator",
        action: "flow.started",
        entityType: "issue",
        entityId: issue.id,
        details: {
          flowName: flow.name,
          ticketType: flow.ticket_type,
          nodeId: firstNode.id,
          nodeCount: flow.nodes.length,
          flowStartedAt: stamp.toISOString(),
        },
      });
      logger.info(
        { issueId: issue.id, flowName: flow.name, nodeId: firstNode.id },
        "flow coordinator: flow.started",
      );
      return {
        issueId: issue.id,
        flowName: flow.name,
        flowNodeId: firstNode.id,
        flowStatus: "running" as FlowStatus,
        execution: runLoop(issue.id),
      };
    },

    /** Event hook: a `flow_gate` approval was decided. Approve advances past
     *  the gate and resumes; reject pauses + surfaces. Stale/mismatched
     *  decisions are classified no-ops (the approval stays decided). */
    onGateDecision: async (input: {
      approvalId: string;
      payload: unknown;
      decision: "approve" | "reject";
      decidedByUserId: string;
    }) => {
      const payload = (input.payload ?? {}) as Record<string, unknown>;
      const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
      const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : null;
      const flowName = typeof payload.flowName === "string" ? payload.flowName : null;
      if (!issueId || !nodeId || !flowName) {
        throw unprocessable(
          `flow_gate approval ${input.approvalId} payload is missing issueId/nodeId/flowName — cannot route the decision.`,
        );
      }
      const issue = await getIssue(issueId);
      if (
        !issue ||
        issue.flowStatus !== "waiting_gate" ||
        issue.flowNodeId !== nodeId ||
        issue.flowName !== flowName
      ) {
        logger.warn(
          {
            approvalId: input.approvalId,
            issueId,
            expected: { flowName, nodeId, flowStatus: "waiting_gate" },
            actual: issue
              ? { flowName: issue.flowName, nodeId: issue.flowNodeId, flowStatus: issue.flowStatus }
              : null,
          },
          "flow coordinator: stale gate decision (classified: stale_gate_decision) — no-op",
        );
        return { resumed: false as const, reason: "stale_gate_decision" as const };
      }
      if (input.decision === "reject") {
        const paused = await transition(issue, { flowStatus: "paused" }, "flow.gate_rejected", {
          nodeId,
          approvalId: input.approvalId,
          decidedByUserId: input.decidedByUserId,
        });
        await surface(
          paused,
          `Flow **${flowName}** gate \`${nodeId}\` was **rejected** — flow paused. ` +
            `A rejection is a new decision point; restart or amend the flow to continue.`,
        );
        return { resumed: false as const, reason: "rejected" as const };
      }
      const { flow } = await deps.loadDefinition(flowName);
      const index = nodeIndex(flow, nodeId);
      if (index < 0) {
        await markFailed(issue, {
          errorType: "flow_node_missing",
          message: `gate node '${nodeId}' no longer exists in flow '${flowName}'`,
        });
        return { resumed: false as const, reason: "flow_node_missing" as const };
      }
      const resumed = await transition(issue, { flowStatus: "running" }, "flow.gate_approved", {
        nodeId,
        approvalId: input.approvalId,
        decidedByUserId: input.decidedByUserId,
      });
      const next = await advanceOrComplete(resumed, flow, index);
      return {
        resumed: true as const,
        execution: next ? runLoop(issueId) : Promise.resolve(),
      };
    },

    /** Periodic sweep: resume `running` flows whose advancement loop died
     *  (process restart, crash) — flowAdvancedAt older than `staleMs`.
     *  Re-executes the CURRENT node (documented at-least-once semantics:
     *  a workflow node interrupted mid-run runs again on resume). */
    sweep: async (staleMs: number) => {
      const cutoff = new Date(deps.now().getTime() - staleMs);
      const stale = await db
        .select(FLOW_COLUMNS)
        .from(issues)
        .where(and(eq(issues.flowStatus, "running"), lt(issues.flowAdvancedAt, cutoff)));
      for (const row of stale as FlowIssue[]) {
        logger.info(
          { issueId: row.id, flowName: row.flowName, flowNodeId: row.flowNodeId, staleSince: row.flowAdvancedAt },
          "flow coordinator: sweep resuming stale running flow",
        );
        await logActivity(db, {
          companyId: row.companyId,
          actorType: "system",
          actorId: "flow-coordinator",
          action: "flow.sweep_resumed",
          entityType: "issue",
          entityId: row.id,
          details: { flowName: row.flowName, flowNodeId: row.flowNodeId, staleSince: row.flowAdvancedAt?.toISOString() ?? null },
        });
        await runLoop(row.id);
      }
      return { resumed: stale.length };
    },

    /** Test/inspection surface. */
    getFlowState: getIssue,
  };
}

export type FlowCoordinator = ReturnType<typeof flowCoordinator>;
