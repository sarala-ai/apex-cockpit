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
 * Honest v1 boundaries (see also node-executors.ts and agent-step.ts):
 * - agent nodes drive a REAL bounded agent run through the fork's native
 *   execution machinery (heartbeat.ts) — never a parallel executor. The
 *   coordinator posts the node's rendered prompt + acceptance as a system
 *   issue comment, commissions a heartbeat run via `wakeup` with that
 *   comment id (the dispatch path renders it into the agent prompt as the
 *   wake comment), records the run linkage on `flowRunId`, and parks at
 *   `waiting_agent` (= run commissioned, awaiting completion). A narrow
 *   hook at the run-status seam (setRunStatusIfRunning) calls
 *   `onAgentRunCompletion`; the sweep is at-least-once recovery. Acceptance
 *   v1 = run succeeded, plus `file_exists:<path>` artifact verification
 *   when declared (agent-step.ts documents exactly what is checked).
 *   Budgets are advisory in v1 — recorded and surfaced, not enforced.
 * - "inbox items" are an issue comment + activity-log entry. The fork's
 *   inbox is a computed read model (no insert API), so flow surfacing rides
 *   the primitives that feed it rather than pretending a feed exists.
 * - no fan-out: one flow per issue, nodes strictly sequential.
 */
import { eq, and, lt, isNull, or, inArray, desc, sql as sqlExpr } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import { logActivity } from "../../services/activity-log.js";
import { approvalService } from "../../services/approvals.js";
import { issueApprovalService } from "../../services/issue-approvals.js";
import { issueService } from "../../services/issues.js";
import {
  findChangeRequestTarget,
  loadFlowDefinition,
  type FlowDefinition,
  type FlowNode,
  type LoadedFlowDefinition,
} from "./definition.js";
import { CliFlowNodeRunner, type FlowNodeRunner } from "./node-executors.js";
import {
  FLOW_AGENT_CONTEXT_KEY,
  FLOW_AGENT_WAKE_REASON,
  FLOW_TERMINAL_RUN_STATUSES,
  buildAgentInstructionComment,
  evaluateAcceptanceV1,
  renderAgentPrompt,
  renderWorkflowParams,
  type AgentPromptContext,
  type FlowTerminalRunStatus,
  type ChangeRequestRound,
} from "./agent-step.js";
import {
  applyGovernedAdapterConfigOverride,
  clearGovernedAdapterConfigOverride,
  derivePermissionPolicy,
} from "./run-policy.js";
import { githubFlowProjection, type FlowProjectionHooks } from "./github-projection.js";

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

/** Activity-log action for a gate rejection that sent work back to its
 *  authoring step. Also the durable home of the reviewer's feedback (see
 *  `readChangeRequestRounds` for why the ledger, not a column). */
export const FLOW_CHANGES_REQUESTED_ACTION = "flow.changes_requested";

/** The flow-state slice of an issue row this module reads and writes. */
export type FlowIssue = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  description: string | null;
  agentBrief: string | null;
  assigneeAgentId: string | null;
  /** The flow's own executor — see resolveExecutorAgent for why this is not
   *  `assigneeAgentId`. Coordinator-owned, cleared at flow-terminal. */
  flowExecutorAgentId: string | null;
  flowName: string | null;
  flowNodeId: string | null;
  flowStatus: string | null;
  flowRunId: string | null;
  flowStartedAt: Date | null;
  flowAdvancedAt: Date | null;
};

type NodeFailure = { errorType: string; message: string };

/** What the launcher hands the agent machinery — the narrowest seam. */
export type AgentRunCommission = {
  agentId: string;
  instructionCommentId: string;
  renderedPrompt: string;
};

export type FlowCoordinatorDeps = {
  loadDefinition: (name: string) => Promise<LoadedFlowDefinition>;
  nodeRunner: FlowNodeRunner;
  /** Commission a REAL bounded agent run through the fork's native execution
   *  path (heartbeat wakeup). Returns the created run's id, or null when the
   *  machinery declined (skipped/deferred) — never throws silently. */
  commissionAgentRun: (
    issue: FlowIssue,
    node: FlowNode,
    commission: AgentRunCommission,
  ) => Promise<{ runId: string } | null>;
  /** Acceptance evaluator (v1 grammar: run-success / file_exists / pr_exists).
   *  Injectable so tests never shell the apex CLI for pr_exists. */
  evaluateAcceptance: typeof evaluateAcceptanceV1;
  /** Decision-ledger projection (GitHub mirror). Fire-and-forget at every
   *  call site: the coordinator only emits thin events and NEVER awaits the
   *  outcome — a projection failure cannot block or fail a flow (the
   *  implementation is failure-isolated, see github-projection.ts). */
  projection: FlowProjectionHooks;
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

/**
 * Governed-permission injection point for flow-commissioned runs. Chosen
 * seam: `issues.assigneeAdapterOverrides` (packages/db/src/schema/issues.ts)
 * — an EXISTING per-issue adapter-config override column, already the last
 * (highest-precedence) layer `mergeModelProfileAdapterConfig` folds into the
 * effective run config in services/heartbeat.ts. This beats the two
 * alternatives the task considered: a global agent-record mutation (would
 * leak into every other issue that agent works, including interactive ones —
 * exactly the blast radius we're trying to avoid) and a hypothetical
 * per-wakeup config override (`WakeupOptions` has no such field; adding one
 * would mean threading a new parameter through `services/heartbeat.ts`'s
 * already enormous config-assembly path for something the fork already
 * solved at the issue layer). Writing here is scoped to exactly the issue
 * the flow is driving, is undone at flow-terminal (see
 * `clearGovernedAdapterConfigOverride`'s call sites in `markFailed` and
 * `advanceOrComplete`), and never touches the agent record itself — so a
 * human interacting with that same agent on a different issue is completely
 * unaffected. See run-policy.ts for why immediate post-wakeup restoration
 * would be unsafe (it would race the async dispatch that actually reads it).
 */
export async function applyFlowRunPermissionOverride(
  db: Db,
  issue: FlowIssue,
  node: FlowNode,
): Promise<{ profile: string } | null> {
  const policy = derivePermissionPolicy(node.agent?.permissions);
  if (policy.notes.length > 0) {
    logger.info(
      { issueId: issue.id, flowNodeId: node.id, profile: policy.profile, notes: policy.notes },
      "flow coordinator: permission policy derivation notes",
    );
  }
  const current = await db
    .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
    .from(issues)
    .where(eq(issues.id, issue.id))
    .then((rows) => rows[0]?.assigneeAdapterOverrides ?? null);
  await db
    .update(issues)
    .set({
      assigneeAdapterOverrides: applyGovernedAdapterConfigOverride(current, policy),
      updatedAt: new Date(),
    })
    .where(eq(issues.id, issue.id));
  return { profile: policy.profile };
}

/** Undo `applyFlowRunPermissionOverride` — see its doc for why this only
 *  runs at flow-terminal, never between a flow's own sequential commissions
 *  and never synchronously after `wakeup()` returns. */
export async function clearFlowRunPermissionOverride(db: Db, issueId: string): Promise<void> {
  const current = await db
    .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
    .from(issues)
    .where(eq(issues.id, issueId))
    .then((rows) => rows[0]?.assigneeAdapterOverrides ?? null);
  if (!current) return;
  await db
    .update(issues)
    .set({ assigneeAdapterOverrides: clearGovernedAdapterConfigOverride(current), updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}

/** Default commission: the fork's native execution path, nothing else.
 *  The wakeup's `commentId` is the instruction channel — heartbeat dispatch
 *  loads that comment (wakeCommentContext) and renders it into the agent's
 *  prompt via buildPaperclipTaskMarkdown's "Latest wake comment" fence. */
async function defaultCommissionAgentRun(
  db: Db,
  issue: FlowIssue,
  node: FlowNode,
  commission: AgentRunCommission,
): Promise<{ runId: string } | null> {
  const permission = await applyFlowRunPermissionOverride(db, issue, node);
  // Lazy import: heartbeat.ts is enormous and only needed on this path.
  const { heartbeatService } = await import("../../services/heartbeat.js");
  const run = await heartbeatService(db).wakeup(commission.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: FLOW_AGENT_WAKE_REASON,
    payload: { issueId: issue.id, commentId: commission.instructionCommentId },
    contextSnapshot: {
      source: "flow.agent_step",
      issueId: issue.id,
      commentId: commission.instructionCommentId,
      flowName: issue.flowName,
      flowNodeId: node.id,
      [FLOW_AGENT_CONTEXT_KEY]: true,
    },
  });
  if (!run) return null;
  const runId = (run as { id: string }).id;
  if (permission) {
    // Visibility stamp (typed columns, see packages/db/src/schema/
    // heartbeat_runs.ts permissionMode/permissionProfile) — best-effort:
    // the run itself was already commissioned successfully, so a stamping
    // failure here is logged, never surfaced as a commission failure.
    try {
      await db
        .update(heartbeatRuns)
        .set({ permissionMode: "governed", permissionProfile: permission.profile })
        .where(eq(heartbeatRuns.id, runId));
    } catch (err) {
      logger.error(
        { err, runId, issueId: issue.id },
        "flow coordinator: failed to stamp permissionMode/permissionProfile on commissioned run",
      );
    }
  }
  return { runId };
}

export function flowCoordinator(db: Db, overrides: Partial<FlowCoordinatorDeps> = {}) {
  const deps: FlowCoordinatorDeps = {
    loadDefinition: overrides.loadDefinition ?? loadFlowDefinition,
    nodeRunner: overrides.nodeRunner ?? new CliFlowNodeRunner(),
    commissionAgentRun:
      overrides.commissionAgentRun ??
      ((issue, node, commission) => defaultCommissionAgentRun(db, issue, node, commission)),
    evaluateAcceptance: overrides.evaluateAcceptance ?? evaluateAcceptanceV1,
    projection: overrides.projection ?? githubFlowProjection(db),
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
    description: issues.description,
    agentBrief: issues.agentBrief,
    assigneeAgentId: issues.assigneeAgentId,
    flowExecutorAgentId: issues.flowExecutorAgentId,
    flowName: issues.flowName,
    flowNodeId: issues.flowNodeId,
    flowStatus: issues.flowStatus,
    flowRunId: issues.flowRunId,
    flowStartedAt: issues.flowStartedAt,
    flowAdvancedAt: issues.flowAdvancedAt,
  };

  /** Record the flow's executor, once. Guarded on still-null so a concurrent
   *  resolution never re-routes a flow already bound to an agent — the same
   *  fill-a-vacuum-never-overwrite discipline the assignee write uses. */
  async function rememberFlowExecutor(issueId: string, agentId: string): Promise<void> {
    await db
      .update(issues)
      .set({ flowExecutorAgentId: agentId, updatedAt: deps.now() })
      .where(and(eq(issues.id, issueId), isNull(issues.flowExecutorAgentId)));
  }

  async function getIssue(issueId: string): Promise<FlowIssue | null> {
    const rows = await db.select(FLOW_COLUMNS).from(issues).where(eq(issues.id, issueId));
    return (rows[0] as FlowIssue | undefined) ?? null;
  }

  /** Compare-and-set transition on the flow columns + classified activity log. */
  async function transition(
    issue: FlowIssue,
    patch: Partial<{
      flowName: string | null;
      flowNodeId: string | null;
      flowStatus: FlowStatus | null;
      flowRunId: string | null;
      flowExecutorAgentId: string | null;
    }>,
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

  /** The issue-derived interpolation context shared by A-node prompts,
   *  acceptance templates, and W-node params. `acceptance` is the RENDERED
   *  acceptance string (or "" where none applies). */
  function promptContext(
    issue: FlowIssue,
    flow: FlowDefinition,
    nodeId: string,
    acceptance: string,
  ): AgentPromptContext {
    return {
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      agentBrief: issue.agentBrief,
      issueId: issue.id,
      flowName: flow.name,
      nodeId,
      acceptance,
    };
  }

  /** Render an A-node's acceptance template against the issue — the agent's
   *  instruction and the completion-time evaluator must see the SAME
   *  concrete string (e.g. pr_exists:…#design/APE-7). */
  function renderedAcceptance(issue: FlowIssue, flow: FlowDefinition, nodeId: string, template: string): string {
    return renderAgentPrompt(template, promptContext(issue, flow, nodeId, template));
  }

  /**
   * Read the change-request rounds still binding on `targetNodeId`.
   *
   * Where this state lives, and why: the activity log, not a new column. The
   * round history IS a decision-ledger fact (who sent what back, when, with
   * which words) — the same ledger the GitHub projection mirrors — and the
   * flow's TYPED columns are deliberately the pointer only (single-writer
   * discipline, see the module doc). A `flowChangeRequestReason` column would
   * duplicate a durable ledger entry and hold exactly one round, which is
   * precisely the "silently drop earlier rounds" failure the design rejects.
   *
   * "Still binding" is a replay over the ledger in chronological order:
   * - `flow.started` clears everything (a restarted flow is a clean slate),
   * - `flow.gate_approved` clears the rounds raised at THAT gate (the reviewer
   *   accepted the work, so their earlier complaints are closed),
   * - `flow.changes_requested` for this flow + target node accumulates.
   * Rounds are numbered at write time, so ordering never depends on
   * same-millisecond `createdAt` ties.
   */
  async function readChangeRequestRounds(
    issueId: string,
    flowName: string,
    targetNodeId: string,
  ): Promise<ChangeRequestRound[]> {
    const rows = await db
      .select({ action: activityLog.action, details: activityLog.details, createdAt: activityLog.createdAt })
      .from(activityLog)
      .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issueId)))
      .orderBy(activityLog.createdAt);
    let rounds: ChangeRequestRound[] = [];
    for (const row of rows) {
      const details = (row.details ?? {}) as Record<string, unknown>;
      if (row.action === "flow.started") {
        rounds = [];
        continue;
      }
      if (row.action === "flow.gate_approved") {
        const gateNodeId = typeof details.nodeId === "string" ? details.nodeId : null;
        if (gateNodeId) rounds = rounds.filter((entry) => entry.gateNodeId !== gateNodeId);
        continue;
      }
      if (row.action !== FLOW_CHANGES_REQUESTED_ACTION) continue;
      if (details.flowName !== flowName || details.targetNodeId !== targetNodeId) continue;
      const feedback = typeof details.reason === "string" ? details.reason : "";
      const gateNodeId = typeof details.gateNodeId === "string" ? details.gateNodeId : "";
      if (!feedback.trim() || !gateNodeId) continue;
      rounds.push({
        round: typeof details.round === "number" ? details.round : rounds.length + 1,
        gateNodeId,
        feedback,
        decidedByUserId: typeof details.decidedByUserId === "string" ? details.decidedByUserId : null,
        at: row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
      });
    }
    return rounds;
  }

  async function markFailed(issue: FlowIssue, failure: NodeFailure): Promise<void> {
    const next = await transition(issue, { flowStatus: "failed" }, "flow.failed", {
      errorType: failure.errorType,
      error: failure.message,
    });
    void deps.projection.flowFailed({
      issueId: next.id,
      nodeId: next.flowNodeId,
      errorType: failure.errorType,
      message: failure.message,
    });
    await clearFlowRunPermissionOverride(db, next.id);
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
    context: { acceptanceEvaluation?: string | null } = {},
  ): Promise<FlowIssue | null> {
    const nextNode = flow.nodes[index + 1];
    if (!nextNode) {
      await transition(
        issue,
        // Executor binding released only on genuine completion. `failed` and
        // `paused` deliberately KEEP it: `retryCurrentNode` resumes the SAME
        // flow, and re-resolving from `assigneeAgentId` at that point is
        // exactly the reviewer-hijack this column exists to prevent.
        { flowStatus: "done", flowRunId: null, flowExecutorAgentId: null },
        "flow.completed",
        { completedNodeId: flow.nodes[index]?.id ?? null },
      );
      void deps.projection.flowCompleted({
        issueId: issue.id,
        completedNodeId: flow.nodes[index]?.id ?? null,
        acceptanceEvaluation: context.acceptanceEvaluation ?? null,
      });
      await clearFlowRunPermissionOverride(db, issue.id);
      return null;
    }
    return transition(issue, { flowNodeId: nextNode.id, flowRunId: null }, "flow.advanced", {
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
    // skip/jump must land back in `running` — a failure can arrive while the
    // flow is parked at `waiting_agent` (agent-run completion), and only
    // `running` flows advance.
    if (node.on_fail === "skip") {
      const advanced = await transition(issue, { flowStatus: "running" }, "flow.node_skipped", {
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
      return transition(issue, { flowNodeId: target, flowStatus: "running", flowRunId: null }, "flow.jumped", {
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
    void deps.projection.gateOpened({
      issueId: issue.id,
      nodeId: node.id,
      prompt: gate.prompt ?? null,
      approvalId: approval.id,
    });
    return null;
  }

  type ChangeRequestOutcome =
    | {
        changesRequested: true;
        gateNodeId: string;
        targetNodeId: string;
        targetSource: "declared" | "derived";
        round: number;
        execution: Promise<void>;
      }
    | {
        changesRequested: false;
        gateNodeId: string;
        targetNodeId: null;
        /** Why changes could not be requested here — surfaced, never swallowed. */
        reason: "no_prior_agent_node" | "declared_target_missing" | "declared_target_not_agent" | "no_reason_given";
      };

  /**
   * `request_changes` — the flow analogue of a pipeline review stage's
   * `request_changes` decision (services/pipelines.ts `reviewCase`): redo the
   * work with a required reason, routed back to a named earlier step. It is a
   * DIFFERENT decision from `reject`: reject means this should not happen at
   * all (the flow stops), request_changes means redo it.
   *
   * Preconditions (flow parked at `waiting_gate` on `gateNodeId`) are the
   * CALLER's to establish — `transition`'s compare-and-set is still the race
   * guard.
   *
   * Re-arms the TARGET node (see `findChangeRequestTarget`), not the gate.
   * Re-arming the gate is what `retryCurrentNode` does from here, and it is
   * useless: it reopens the same question over the same unchanged artifact.
   *
   * No double-commission risk: this only moves the pointer and hands off to
   * `runLoop`, so the re-commission goes through `executeAgentNode`'s existing
   * deferral-aware guard — if a run already holds the issue's execution lock,
   * `commissionAgentRun` returns null, the flow stays at `waiting_agent`, and
   * heartbeat promotes the deferred wake when the live run finishes.
   */
  async function attemptRequestChanges(
    issue: FlowIssue,
    flow: FlowDefinition,
    input: { gateNodeId: string; reason: string; decidedByUserId: string; approvalId: string | null },
  ): Promise<ChangeRequestOutcome> {
    const reason = input.reason.trim();
    const target = findChangeRequestTarget(flow, input.gateNodeId);
    if (!target.found) {
      return { changesRequested: false, gateNodeId: input.gateNodeId, targetNodeId: null, reason: target.reason };
    }
    if (!reason) {
      return { changesRequested: false, gateNodeId: input.gateNodeId, targetNodeId: null, reason: "no_reason_given" };
    }
    const prior = await readChangeRequestRounds(issue.id, flow.name, target.node.id);
    const round = prior.length + 1;
    const returned = await transition(
      issue,
      { flowNodeId: target.node.id, flowStatus: "running", flowRunId: null },
      FLOW_CHANGES_REQUESTED_ACTION,
      {
        gateNodeId: input.gateNodeId,
        targetNodeId: target.node.id,
        targetSource: target.source,
        reason,
        decidedByUserId: input.decidedByUserId,
        approvalId: input.approvalId,
        round,
      },
    );
    void deps.projection.changesRequested({
      issueId: returned.id,
      gateNodeId: input.gateNodeId,
      targetNodeId: target.node.id,
      reason,
      decidedByUserId: input.decidedByUserId,
      round,
    });
    const between = flow.nodes.slice(target.index + 1, nodeIndex(flow, input.gateNodeId));
    await surface(
      returned,
      `Flow **${flow.name}** gate \`${input.gateNodeId}\`: **changes requested** — the work goes back to ` +
        `\`${target.node.id}\` (round ${round}). Your reason is delivered to that step verbatim.` +
        (between.length > 0
          ? `\n\nThe ${between.length} step${between.length === 1 ? "" : "s"} between it and this gate ` +
            `(${between.map((n) => `\`${n.id}\``).join(", ")}) re-run on the way back, so the gate reopens ` +
            `only on work that has passed the same automated bar.`
          : "") +
        `\n\n> ${reason.split("\n").join("\n> ")}`,
    );
    return {
      changesRequested: true,
      gateNodeId: input.gateNodeId,
      targetNodeId: target.node.id,
      targetSource: target.source,
      round,
      execution: runLoop(issue.id),
    };
  }

  /**
   * Resolve the agent that executes this flow's agent nodes.
   *
   * Order: the flow's OWN recorded executor (`flowExecutorAgentId`) → the
   * issue's assignee → the company's single assignable agent (deterministic
   * dispatch; anything ambiguous is a classified failure, never a guess). The
   * first resolution is written back to `flowExecutorAgentId` and every later
   * node of the same flow uses it.
   *
   * Why the flow keeps its own column instead of re-reading `assigneeAgentId`
   * each time: `assigneeAgentId` has a SECOND writer. The per-issue execution
   * policy (services/issue-execution-policy.ts, `buildPendingStagePatch`)
   * reassigns the issue to the REVIEWER when it intercepts a done-transition,
   * deliberately excluding the executor so review is independent. Re-reading
   * that column mid-flow therefore commissioned the flow's next agent step to
   * the reviewer — silently defeating the independence the execution policy
   * exists to enforce. Resolving once and remembering is the fix; it also
   * makes a mid-flow reassignment by a human no longer silently re-route the
   * remaining steps, which was never intended either.
   *
   * The coordinator still fills an assignee vacuum on first resolution (so the
   * ticket has a visible owner), but never re-routes an existing assignment.
   */
  async function resolveExecutorAgent(issue: FlowIssue): Promise<
    { ok: true; agentId: string; assigned: boolean } | { ok: false; failure: NodeFailure }
  > {
    if (issue.flowExecutorAgentId) {
      return { ok: true, agentId: issue.flowExecutorAgentId, assigned: false };
    }
    if (issue.assigneeAgentId) {
      await rememberFlowExecutor(issue.id, issue.assigneeAgentId);
      return { ok: true, agentId: issue.assigneeAgentId, assigned: false };
    }
    // Invokable statuses (shared agent-eligibility taxonomy): the commissioned
    // wakeup must actually dispatch, so paused/terminated/pending_approval
    // agents (e.g. auto-provisioned built-ins parked as `paused`) don't count.
    const candidates = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, issue.companyId),
          inArray(agents.status, ["active", "idle", "running", "error"]),
        ),
      );
    if (candidates.length !== 1) {
      return {
        ok: false,
        failure: {
          errorType: "flow_agent_unavailable",
          message:
            candidates.length === 0
              ? "no assignee agent on the issue and no assignable agent exists in the company"
              : `no assignee agent on the issue and ${candidates.length} assignable agents exist — ambiguous, assign one explicitly`,
        },
      };
    }
    const agentId = candidates[0].id;
    // Assignment write guarded on still-unassigned: the coordinator only
    // fills a vacuum, it never re-routes someone else's assignment.
    const stamp = deps.now();
    const assigned = await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: stamp })
      .where(and(eq(issues.id, issue.id), isNull(issues.assigneeAgentId)))
      .returning({ id: issues.id });
    if (assigned.length === 0) {
      // Someone assigned concurrently — re-read and use theirs.
      const fresh = await getIssue(issue.id);
      if (fresh?.flowExecutorAgentId) {
        return { ok: true, agentId: fresh.flowExecutorAgentId, assigned: false };
      }
      if (fresh?.assigneeAgentId) {
        await rememberFlowExecutor(issue.id, fresh.assigneeAgentId);
        return { ok: true, agentId: fresh.assigneeAgentId, assigned: false };
      }
      return {
        ok: false,
        failure: { errorType: "flow_agent_unavailable", message: "agent assignment raced and no assignee remains" },
      };
    }
    await rememberFlowExecutor(issue.id, agentId);
    return { ok: true, agentId, assigned: true };
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
    const executor = await resolveExecutorAgent(issue);
    if (!executor.ok) {
      return applyOnFail(issue, flow, index, executor.failure);
    }
    const acceptance = renderedAcceptance(issue, flow, node.id, agent.acceptance);
    const renderedPrompt = renderAgentPrompt(
      agent.prompt_template,
      promptContext(issue, flow, node.id, acceptance),
    );
    // Rework feedback rides the SAME channel the instruction already uses (the
    // wake comment) rather than a second one: whatever the founder wrote at the
    // gate is part of this step's brief now, not an out-of-band note the agent
    // may or may not read. Empty on a first pass — the section only appears
    // when this node was actually sent back.
    const changeRequestRounds = await readChangeRequestRounds(issue.id, flow.name, node.id);
    // Park first (single-writer CAS out of `running`): waiting_agent now means
    // "run commissioned (or commissioning), awaiting completion".
    const waiting = await transition(
      issue,
      { flowStatus: "waiting_agent", flowRunId: null },
      "flow.agent_step_pending",
      {
        nodeId: node.id,
        agentId: executor.agentId,
        agentAutoAssigned: executor.assigned,
        acceptance,
        budget: agent.budget ?? null,
        changeRequestRound: changeRequestRounds.length > 0 ? Math.max(...changeRequestRounds.map((r) => r.round)) : null,
      },
    );
    // The instruction comment is the run's wake comment — the channel the
    // dispatch path renders into the agent's prompt. Its failure is fatal to
    // the step (a run without its instruction is not this node's run).
    let instructionCommentId: string;
    try {
      const comment = await issuesSvc.addComment(
        waiting.id,
        buildAgentInstructionComment({
          flowName: flow.name,
          nodeId: node.id,
          renderedPrompt,
          acceptance,
          budget: agent.budget ?? null,
          changeRequestRounds,
        }),
        {},
      );
      instructionCommentId = (comment as { id: string }).id;
    } catch (err) {
      return applyOnFail(waiting, flow, index, {
        errorType: "agent_instruction_comment_failed",
        message: `could not post the agent step's instruction comment: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    try {
      const commissioned = await deps.commissionAgentRun(waiting, node, {
        agentId: executor.agentId,
        instructionCommentId,
        renderedPrompt,
      });
      if (!commissioned) {
        // Deferred/skipped wakeup. Deferral is the common real case: the issue
        // already has an active run holding the execution lock, and heartbeat
        // will PROMOTE the deferred wake (carrying our flow context) once it
        // finishes — the completion hook accepts a null flowRunId, and the
        // sweep re-links by context markers. A hard skip (heartbeat disabled,
        // company inactive) leaves nothing to promote — the sweep classifies
        // that as agent_run_not_commissioned after the staleness window.
        // Either way: surfaced + classified, never silent, never a premature
        // pause that strands the promoted run.
        const deferred = await transition(waiting, {}, "flow.agent_run_deferred", {
          nodeId: node.id,
          agentId: executor.agentId,
          instructionCommentId,
        });
        await surface(
          deferred,
          `Flow **${flow.name}** agent step \`${node.id}\`: the wakeup was deferred behind the agent's ` +
            `current run (or declined). The step's instruction is queued; the flow stays at ` +
            `\`waiting_agent\` and advances when the promoted run completes (the sweep classifies a ` +
            `pause if no run ever materializes).`,
        );
        return null;
      }
      await transition(waiting, { flowRunId: commissioned.runId }, "flow.agent_run_commissioned", {
        nodeId: node.id,
        runId: commissioned.runId,
        agentId: executor.agentId,
        instructionCommentId,
      });
      void deps.projection.agentRunCommissioned({
        issueId: waiting.id,
        nodeId: node.id,
        runId: commissioned.runId,
      });
    } catch (err) {
      if (err instanceof FlowStateConflictError) throw err;
      return applyOnFail(waiting, flow, index, {
        errorType:
          err instanceof Error && "errorType" in err && typeof (err as { errorType?: unknown }).errorType === "string"
            ? (err as { errorType: string }).errorType
            : "agent_run_commission_failed",
        message: `commissioning the bounded agent run failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return null;
  }

  /** Shared completion logic for the run-status hook and the sweep. The issue
   *  MUST currently be parked at `waiting_agent` on this node. */
  async function processAgentRunCompletion(
    issue: FlowIssue,
    input: { runId: string; runStatus: FlowTerminalRunStatus; error?: string | null },
  ): Promise<{ advanced: boolean; reason?: string; execution?: Promise<void> }> {
    const { flow } = await deps.loadDefinition(issue.flowName as string);
    const index = nodeIndex(flow, issue.flowNodeId);
    if (index < 0) {
      await markFailed(issue, {
        errorType: "flow_node_missing",
        message: `current node '${issue.flowNodeId}' not found in flow '${issue.flowName}'`,
      });
      return { advanced: false, reason: "flow_node_missing" };
    }
    const node = flow.nodes[index] as FlowNode;
    if (node.kind !== "agent" || !node.agent) {
      await markFailed(issue, {
        errorType: "flow_node_config_missing",
        message: `run ${input.runId} completed for node '${node.id}' which is no longer an agent node`,
      });
      return { advanced: false, reason: "flow_node_config_missing" };
    }
    if (input.runStatus !== "succeeded") {
      await applyOnFail(issue, flow, index, {
        errorType: `agent_run_${input.runStatus}`,
        message:
          input.error ?? `commissioned agent run ${input.runId} ended with status '${input.runStatus}'`,
      });
      return { advanced: false, reason: `agent_run_${input.runStatus}` };
    }
    const acceptanceString = renderedAcceptance(issue, flow, node.id, node.agent.acceptance);
    const acceptance = await deps.evaluateAcceptance(acceptanceString);
    void deps.projection.acceptanceEvaluated({
      issueId: issue.id,
      nodeId: node.id,
      runId: input.runId,
      ok: acceptance.ok,
      evaluation: acceptance.evaluation,
    });
    if (!acceptance.ok) {
      await applyOnFail(issue, flow, index, {
        errorType: "agent_acceptance_failed",
        message: `${acceptance.message} (run ${input.runId} succeeded; ${acceptance.evaluation})`,
      });
      return { advanced: false, reason: "agent_acceptance_failed" };
    }
    const resumed = await transition(issue, { flowStatus: "running" }, "flow.agent_step_succeeded", {
      nodeId: node.id,
      runId: input.runId,
      acceptance: acceptanceString,
      acceptanceEvaluation: acceptance.evaluation,
    });
    const next = await advanceOrComplete(resumed, flow, index, {
      acceptanceEvaluation: acceptance.evaluation,
    });
    return { advanced: true, execution: next ? runLoop(issue.id) : Promise.resolve() };
  }

  /** Sweep-side recovery for a stale `waiting_agent` flow. Returns true when
   *  the flow was moved (advanced, paused, or failed), false for no-op. */
  async function recoverWaitingAgent(issue: FlowIssue): Promise<boolean> {
    const pauseClassified = async (failure: NodeFailure): Promise<boolean> => {
      const { flow } = await deps.loadDefinition(issue.flowName as string);
      const index = nodeIndex(flow, issue.flowNodeId);
      if (index < 0) {
        await markFailed(issue, {
          errorType: "flow_node_missing",
          message: `current node '${issue.flowNodeId}' not found in flow '${issue.flowName}' (during: ${failure.message})`,
        });
        return true;
      }
      await applyOnFail(issue, flow, index, failure);
      return true;
    };

    let linkedRunId = issue.flowRunId;
    if (!linkedRunId) {
      // No recorded commission: either the launch crashed before linkage, or
      // the wakeup was deferred and heartbeat later promoted it into a run
      // carrying our flow context markers. Look for that run before giving
      // up (querying heartbeat's own jsonb snapshot is its supported read
      // pattern — flow STATE stays in typed columns).
      const marker = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(
          and(
            sqlExpr`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
            sqlExpr`${heartbeatRuns.contextSnapshot} ->> 'flowNodeId' = ${issue.flowNodeId}`,
            sqlExpr`${heartbeatRuns.contextSnapshot} ->> 'flowAgentStep' = 'true'`,
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1)
        .then((r) => r[0] ?? null);
      if (!marker) {
        return pauseClassified({
          errorType: "agent_run_not_commissioned",
          message:
            "flow parked at waiting_agent past the staleness window with no commissioned run recorded " +
            "and no run carrying this step's context — the launch was interrupted or the wakeup was skipped",
        });
      }
      linkedRunId = marker.id;
    }

    // Resolve the run, following the heartbeat process-loss retry chain
    // (bounded — a chain deeper than 5 is itself suspicious).
    let runId = linkedRunId;
    let run =
      (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((r) => r[0])) ?? null;
    for (let depth = 0; run && depth < 5; depth += 1) {
      const retry = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.retryOfRunId, run.id))
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(1)
        .then((r) => r[0] ?? null);
      if (!retry) break;
      run = retry;
      runId = retry.id;
    }
    if (!run) {
      return pauseClassified({
        errorType: "agent_run_lost",
        message: `commissioned run ${runId} no longer exists — cannot observe completion`,
      });
    }
    if (["queued", "running", "scheduled_retry"].includes(run.status)) {
      if (runId !== issue.flowRunId) {
        // The machinery retried the run; re-link so the completion hook matches.
        await transition(issue, { flowRunId: runId }, "flow.agent_run_relinked", {
          nodeId: issue.flowNodeId,
          fromRunId: issue.flowRunId,
          toRunId: runId,
        });
        return true;
      }
      return false; // still in flight — correct silence
    }
    if (run.status === "interrupted") {
      // Terminal-but-revivable ended the chain without a retry: classify.
      return pauseClassified({
        errorType: "agent_run_interrupted",
        message: `commissioned run ${runId} was interrupted and no retry followed`,
      });
    }
    if ((FLOW_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) {
      const result = await processAgentRunCompletion(
        runId === issue.flowRunId ? issue : { ...issue, flowRunId: runId },
        { runId, runStatus: run.status as FlowTerminalRunStatus, error: run.error ?? null },
      );
      if (result.execution) await result.execution;
      return true;
    }
    return pauseClassified({
      errorType: "agent_run_status_unknown",
      message: `commissioned run ${runId} is in unrecognized status '${run.status}'`,
    });
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
            // W-node params are templates too: `head: design/{{identifier}}`
            // resolves against the ticket before the workflow runs.
            const result = await deps.nodeRunner.runWorkflow({
              workflow: node.workflow.workflow,
              params: renderWorkflowParams(
                node.workflow.params ?? {},
                promptContext(issue, flow, node.id, ""),
              ),
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
          flowRunId: null,
          // A new flow resolves its executor afresh; never inherits the
          // previous flow's binding.
          flowExecutorAgentId: null,
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
      // Fire-and-forget: creates the GitHub mirror (board-origin issues) and
      // posts the flow-started ledger entry. Never awaited, never blocking.
      void deps.projection.flowStarted({ issueId: issue.id, flowName: flow.name });
      return {
        issueId: issue.id,
        flowName: flow.name,
        flowNodeId: firstNode.id,
        flowStatus: "running" as FlowStatus,
        execution: runLoop(issue.id),
      };
    },

    /** Event hook: a `flow_gate` approval was decided. The decision vocabulary
     *  is the pipelines one (`PipelineReviewDecision`): approve advances past
     *  the gate and resumes; `request_changes` routes the work back to the
     *  gate's change-request target with the reviewer's reason; reject stops
     *  the flow (paused). Stale/mismatched decisions are classified no-ops
     *  (the approval stays decided). */
    onGateDecision: async (input: {
      approvalId: string;
      payload: unknown;
      decision: "approve" | "reject" | "request_changes";
      decidedByUserId: string;
      /** The reviewer's reason (`approvals.decision_note`). Required by the
       *  route for both `reject` and `request_changes` (classified 400), the
       *  way a review stage's `requireRejectReason` /
       *  `requireRequestChangesReason` do. Optional in this signature so a
       *  decision arriving from any other caller still lands somewhere honest
       *  rather than throwing mid-transition. */
      reason?: string | null;
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
      // `request_changes` — redo the work with a required reason, routed back
      // to the gate's change-request target. Distinct from `reject`, which
      // means the work should not happen at all.
      if (input.decision === "request_changes") {
        let flow: FlowDefinition | null = null;
        try {
          flow = (await deps.loadDefinition(flowName)).flow;
        } catch (err) {
          logger.error(
            { err, issueId, flowName, nodeId },
            "flow coordinator: could not load the flow definition to route request_changes — falling back to pause",
          );
        }
        const outcome = flow
          ? await attemptRequestChanges(issue, flow, {
              gateNodeId: nodeId,
              reason: input.reason ?? "",
              decidedByUserId: input.decidedByUserId,
              approvalId: input.approvalId,
            })
          : null;
        if (outcome?.changesRequested) {
          return {
            resumed: true as const,
            reason: "changes_requested" as const,
            targetNodeId: outcome.targetNodeId,
            round: outcome.round,
            execution: outcome.execution,
          };
        }
        // Nothing to send the work back to. Keep today's pause behaviour, and
        // say WHICH case it is rather than the old undifferentiated
        // "restart or amend the flow".
        const blocked = outcome?.reason ?? "flow_definition_unavailable";
        const why =
          blocked === "no_prior_agent_node"
            ? `no agent step precedes this gate in flow \`${flowName}\`, so there is no step to send the work back to`
            : blocked === "declared_target_missing"
              ? `this gate declares a request_changes target that no longer exists in flow \`${flowName}\``
              : blocked === "declared_target_not_agent"
                ? `this gate's declared request_changes target is not an agent step, so it cannot act on your reason`
                : blocked === "no_reason_given"
                  ? "no reason was recorded with the decision, and a reason is what the redoing step acts on"
                  : "the flow definition could not be read, so the work could not be routed back automatically";
        const paused = await transition(issue, { flowStatus: "paused" }, "flow.changes_request_blocked", {
          nodeId,
          approvalId: input.approvalId,
          decidedByUserId: input.decidedByUserId,
          blocked,
        });
        await surface(
          paused,
          `Flow **${flowName}** gate \`${nodeId}\`: **changes requested**, but the flow is paused because ${why}. ` +
            `Restart or amend the flow to continue.`,
        );
        return { resumed: false as const, reason: "changes_request_blocked" as const, blocked };
      }
      if (input.decision === "reject") {
        // Reject = this should not happen at all. The flow stops; it does NOT
        // go back for another round (that is `request_changes`). Paused rather
        // than failed so the audit trail and `abandonFlow`/`retryCurrentNode`
        // remain available to the operator.
        const paused = await transition(issue, { flowStatus: "paused" }, "flow.gate_rejected", {
          nodeId,
          approvalId: input.approvalId,
          decidedByUserId: input.decidedByUserId,
          reason: input.reason ?? null,
        });
        void deps.projection.gateDecided({
          issueId,
          nodeId,
          decision: "reject",
          decidedByUserId: input.decidedByUserId,
          approvalId: input.approvalId,
        });
        await surface(
          paused,
          `Flow **${flowName}** gate \`${nodeId}\` was **rejected** — flow paused. Rejection means this work ` +
            `should not proceed at all; to send it back for another round instead, request changes.` +
            (input.reason?.trim() ? `\n\n> ${input.reason.trim().split("\n").join("\n> ")}` : ""),
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
      void deps.projection.gateDecided({
        issueId,
        nodeId,
        decision: "approve",
        decidedByUserId: input.decidedByUserId,
        approvalId: input.approvalId,
      });
      const next = await advanceOrComplete(resumed, flow, index);
      return {
        resumed: true as const,
        execution: next ? runLoop(issueId) : Promise.resolve(),
      };
    },

    /** Event hook: a commissioned agent run reached a terminal status (called
     *  from the narrow seam in heartbeat's setRunStatusIfRunning, and by the
     *  sweep as at-least-once recovery). Stale/mismatched completions are
     *  classified no-ops. */
    onAgentRunCompletion: async (input: {
      runId: string;
      issueId: string;
      flowName: string | null;
      flowNodeId: string | null;
      runStatus: FlowTerminalRunStatus;
      error?: string | null;
    }) => {
      const issue = await getIssue(input.issueId);
      const stale =
        !issue ||
        issue.flowStatus !== "waiting_agent" ||
        (input.flowNodeId !== null && issue.flowNodeId !== input.flowNodeId) ||
        (input.flowName !== null && issue.flowName !== input.flowName) ||
        (issue.flowRunId !== null && issue.flowRunId !== input.runId);
      if (stale) {
        logger.warn(
          {
            runId: input.runId,
            issueId: input.issueId,
            expected: { flowName: input.flowName, flowNodeId: input.flowNodeId, flowStatus: "waiting_agent" },
            actual: issue
              ? {
                  flowName: issue.flowName,
                  flowNodeId: issue.flowNodeId,
                  flowStatus: issue.flowStatus,
                  flowRunId: issue.flowRunId,
                }
              : null,
          },
          "flow coordinator: stale agent-run completion (classified: stale_agent_completion) — no-op",
        );
        return { advanced: false as const, reason: "stale_agent_completion" as const };
      }
      return processAgentRunCompletion(issue as FlowIssue, {
        runId: input.runId,
        runStatus: input.runStatus,
        error: input.error ?? null,
      });
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

      // waiting_agent recovery: the completion hook is best-effort in-process;
      // this path is the at-least-once guarantee. Resolve the commissioned
      // run (following the process-loss retry chain), then either process its
      // terminal status, re-link to a live retry, or classify the loss.
      const staleAgent = await db
        .select(FLOW_COLUMNS)
        .from(issues)
        .where(and(eq(issues.flowStatus, "waiting_agent"), lt(issues.flowAdvancedAt, cutoff)));
      let agentRecovered = 0;
      for (const row of staleAgent as FlowIssue[]) {
        try {
          const outcome = await recoverWaitingAgent(row);
          if (outcome) agentRecovered += 1;
        } catch (err) {
          if (err instanceof FlowStateConflictError) {
            logger.error({ err, issueId: row.id }, "flow coordinator: sweep agent recovery hit a state conflict — skipping");
            continue;
          }
          logger.error(
            { err, issueId: row.id, flowRunId: row.flowRunId },
            "flow coordinator: sweep agent recovery failed (classified: agent_sweep_failed)",
          );
        }
      }
      return { resumed: stale.length, agentRecovered };
    },

    /**
     * Operator recovery: re-arm the CURRENT node for re-execution. Valid only
     * from `paused` or `failed` — the two "the loop stopped and a human must
     * decide" terminals `waiting_gate` deliberately excludes (that's a normal
     * wait, not a stuck state; use the gate decision instead). Re-parks the
     * flow at `running` on the SAME node with a cleared `flowRunId`, so the
     * next loop tick re-executes it fresh: a workflow/check node just runs
     * again, an agent node gets a brand-new instruction comment + commission
     * (never resurrects the old, already-terminal run). Flow identity
     * (flowName/flowNodeId/flowStartedAt) is untouched — this is a resume,
     * not a new flow.
     */
    retryCurrentNode: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");
      if (!issue.flowStatus || !["paused", "failed"].includes(issue.flowStatus)) {
        throw conflict(
          `Flow for issue ${issueId} is not paused or failed (status: ${issue.flowStatus ?? "none"}) — cannot retry.`,
          { errorType: "flow_invalid_transition", flowStatus: issue.flowStatus },
        );
      }
      if (!issue.flowName || !issue.flowNodeId) {
        throw unprocessable(
          `Issue ${issueId} has no active flow node to retry.`,
          { errorType: "flow_node_missing" },
        );
      }
      const { flow } = await deps.loadDefinition(issue.flowName);
      const index = nodeIndex(flow, issue.flowNodeId);
      if (index < 0) {
        throw unprocessable(
          `Flow node '${issue.flowNodeId}' no longer exists in flow '${issue.flowName}' — cannot retry.`,
          { errorType: "flow_node_missing" },
        );
      }
      const rearmed = await transition(
        issue,
        { flowStatus: "running", flowRunId: null },
        "flow.retry_requested",
        { nodeId: issue.flowNodeId, fromStatus: issue.flowStatus },
      );
      return {
        issueId: rearmed.id,
        flowName: rearmed.flowName as string,
        flowNodeId: rearmed.flowNodeId as string,
        flowStatus: rearmed.flowStatus as FlowStatus,
        execution: runLoop(issueId),
      };
    },

    /**
     * `request_changes` as a directly callable operation: send a gate's work
     * back to its change-request target, carrying the reviewer's reason.
     *
     * Valid only from `waiting_gate` on `gateNodeId` — this is a REVIEW
     * decision, not an operator recovery (`retryCurrentNode` covers
     * paused/failed, and at a gate it would only reopen the same gate over the
     * same artifact, which is the gap this closes).
     *
     * The decided approval is deliberately left decided: it is the audit
     * record of the round. The gate creates a NEW pending approval when the
     * flow walks back into it (`executeGateNode` always creates one), so no
     * stale approval lingers and the rounds are separately readable.
     */
    requestChangesFromGate: async (
      issueId: string,
      input: { gateNodeId: string; reason: string; decidedByUserId: string; approvalId?: string | null },
    ) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");
      if (issue.flowStatus !== "waiting_gate" || issue.flowNodeId !== input.gateNodeId) {
        throw conflict(
          `Flow for issue ${issueId} is not waiting at gate '${input.gateNodeId}' ` +
            `(status: ${issue.flowStatus ?? "none"}, node: ${issue.flowNodeId ?? "none"}) — cannot request changes.`,
          { errorType: "flow_invalid_transition", flowStatus: issue.flowStatus },
        );
      }
      if (!issue.flowName) {
        throw unprocessable(`Issue ${issueId} has no active flow.`, {
          errorType: "flow_node_missing",
        });
      }
      if (!input.reason?.trim()) {
        throw unprocessable(
          "Requesting changes requires a reason — it is what the step redoing the work acts on.",
          { errorType: "gate_review_reason_required" },
        );
      }
      const { flow } = await deps.loadDefinition(issue.flowName);
      return attemptRequestChanges(issue, flow, {
        gateNodeId: input.gateNodeId,
        reason: input.reason,
        decidedByUserId: input.decidedByUserId,
        approvalId: input.approvalId ?? null,
      });
    },

    /**
     * Operator recovery: terminal-fail the flow cleanly. Valid from
     * `paused`, `failed` (already terminal — idempotent no-op landing) or
     * `waiting_gate` (closes out the dangling `flow_gate` approval first, so
     * a later stray decision on it is a harmless classified no-op rather than
     * a live approval nobody will ever resolve). Clears the governed
     * permission override exactly like the other terminal paths
     * (`markFailed`, `advanceOrComplete`'s done branch) — see
     * `applyFlowRunPermissionOverride`'s doc for why that's the only safe
     * place to undo it.
     */
    abandonFlow: async (input: { issueId: string; decidedByUserId?: string | null }) => {
      const issue = await getIssue(input.issueId);
      if (!issue) throw notFound("Issue not found");
      const abandonable: FlowStatus[] = ["paused", "failed", "waiting_gate"];
      if (!issue.flowStatus || !abandonable.includes(issue.flowStatus as FlowStatus)) {
        throw conflict(
          `Flow for issue ${input.issueId} is not paused, failed, or waiting on a gate ` +
            `(status: ${issue.flowStatus ?? "none"}) — cannot abandon.`,
          { errorType: "flow_invalid_transition", flowStatus: issue.flowStatus },
        );
      }
      if (issue.flowStatus === "waiting_gate") {
        const linked = await issueApprovalsSvc.listApprovalsForIssue(issue.id);
        const pendingGate = linked.find(
          (approval) => approval.type === FLOW_GATE_APPROVAL_TYPE && approval.status === "pending",
        );
        if (pendingGate) {
          await approvalsSvc.reject(
            pendingGate.id,
            input.decidedByUserId ?? "flow-coordinator",
            "Flow abandoned by operator",
          );
        }
      }
      const abandoned = await transition(issue, { flowStatus: "failed" }, "flow.abandoned", {
        nodeId: issue.flowNodeId,
        fromStatus: issue.flowStatus,
        decidedByUserId: input.decidedByUserId ?? null,
      });
      await clearFlowRunPermissionOverride(db, abandoned.id);
      await surface(
        abandoned,
        `Flow **${abandoned.flowName}** was **abandoned** by an operator at node \`${abandoned.flowNodeId}\`.`,
      );
      return abandoned;
    },

    /** Test/inspection surface. */
    getFlowState: getIssue,
  };
}

export type FlowCoordinator = ReturnType<typeof flowCoordinator>;
