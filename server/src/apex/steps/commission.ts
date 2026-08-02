/**
 * Commissioning ONE bounded agent run — the only door in the substrate to a
 * language model, and therefore the one place the permission profile is
 * applied.
 *
 * This is a MOVE, not a rewrite: the bodies below are the flow coordinator's
 * `applyFlowRunPermissionOverride` / `clearFlowRunPermissionOverride` /
 * `defaultCommissionAgentRun`, carried across unchanged so that deleting the
 * coordinator loses no behaviour. What changed is who calls them — a pipeline
 * case's agent step rather than a flow node.
 *
 * The instruction-injection channel (discovered, not invented): a heartbeat
 * wakeup carrying a `commentId` has that issue comment loaded at dispatch
 * (services/heartbeat.ts, `wakeCommentContext`) and rendered into the agent's
 * prompt as the "Latest wake comment" fence. So the host posts the step's
 * rendered prompt and acceptance as a system comment and passes its id through
 * the wakeup: the run's instruction IS that comment.
 *
 * WHY THE PERMISSION OVERRIDE EXISTS, since it looks like ceremony: an agent
 * commissioned unattended would otherwise inherit its adapter's configured
 * default, and that default is `dangerouslySkipPermissions = true` for a human
 * sitting in front of it. Nobody is sitting in front of this one. The override
 * is scoped to the issue, applied before the wake and cleared when the process
 * reaches a terminal step.
 *
 * It applies to AGENT steps ONLY. A `run` step never comes through here: its
 * safety comes from the target being named, catalogued and previewed, not from
 * a profile, and threading one through would be config an author has to learn
 * to ignore (docs/architecture/process-definition.md §2a).
 */
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  applyGovernedAdapterConfigOverride,
  clearGovernedAdapterConfigOverride,
  derivePermissionPolicy,
} from "./run-policy.js";

/** The wake reason and context marker a commissioned step run carries.
 *
 * The literal VALUES are deliberately unchanged from the flow front-end's
 * (`flow_agent_step` / `flowAgentStep`) even though the front-end is gone. A
 * run commissioned before this change is still in flight, and its context
 * snapshot is immutable — renaming the marker would orphan exactly the runs
 * the completion hook exists to catch. The symbols are renamed because the
 * concept is no longer flow-specific; the strings are not, because they are
 * data already written down. */
export const STEP_AGENT_WAKE_REASON = "flow_agent_step";
export const STEP_AGENT_CONTEXT_KEY = "flowAgentStep";

/** Run statuses that count as a completed commission. `interrupted` is
 *  deliberately absent: the heartbeat machinery may still revive it through
 *  its process-loss retry chain, and the sweep resolves that chain. */
export const STEP_TERMINAL_RUN_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"] as const;
export type StepTerminalRunStatus = (typeof STEP_TERMINAL_RUN_STATUSES)[number];

export type BoundedRunCommission = {
  /** The issue the run happens on — the case's conversation. */
  issueId: string;
  agentId: string;
  /** The instruction comment; it becomes the run's wake comment. */
  instructionCommentId: string;
  /** The step's declared permissions, read defensively by run-policy. */
  permissions: unknown;
  /** For the run's context snapshot, so a completion can find its case. */
  definitionName: string;
  stepKey: string;
};

/** Apply the governed permission profile to the issue's adapter overrides for
 *  the duration of the commissioned run. Returns the profile it settled on. */
export async function applyStepRunPermissionOverride(
  db: Db,
  input: { issueId: string; stepKey: string; permissions: unknown },
): Promise<{ profile: string }> {
  const policy = derivePermissionPolicy(input.permissions);
  if (policy.notes.length > 0) {
    logger.info(
      { issueId: input.issueId, stepKey: input.stepKey, profile: policy.profile, notes: policy.notes },
      "step commission: permission policy derivation notes",
    );
  }
  const current = await db
    .select({ assigneeAdapterOverrides: issues.assigneeAdapterOverrides })
    .from(issues)
    .where(eq(issues.id, input.issueId))
    .then((rows) => rows[0]?.assigneeAdapterOverrides ?? null);
  await db
    .update(issues)
    .set({
      assigneeAdapterOverrides: applyGovernedAdapterConfigOverride(current, policy),
      updatedAt: new Date(),
    })
    .where(eq(issues.id, input.issueId));
  return { profile: policy.profile };
}

/** Undo the override. Only ever called when the process reaches a terminal
 *  step — never between a process's own sequential commissions, and never
 *  synchronously after `wakeup()` returns, because the run it governs is still
 *  starting up at that moment. */
export async function clearStepRunPermissionOverride(db: Db, issueId: string): Promise<void> {
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

/**
 * Commission the run. `null` means the machinery DEFERRED or declined — not
 * that it failed. Deferral is the common real case (the agent already holds
 * the execution lock and heartbeat will promote this wake when it finishes),
 * which is why the caller parks rather than pausing.
 */
export async function commissionBoundedAgentRun(
  db: Db,
  commission: BoundedRunCommission,
): Promise<{ runId: string } | null> {
  const permission = await applyStepRunPermissionOverride(db, {
    issueId: commission.issueId,
    stepKey: commission.stepKey,
    permissions: commission.permissions,
  });
  // Lazy import: heartbeat.ts is enormous and only needed on this path.
  const { heartbeatService } = await import("../../services/heartbeat.js");
  const run = await heartbeatService(db).wakeup(commission.agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: STEP_AGENT_WAKE_REASON,
    payload: { issueId: commission.issueId, commentId: commission.instructionCommentId },
    contextSnapshot: {
      source: "step.agent",
      issueId: commission.issueId,
      commentId: commission.instructionCommentId,
      processName: commission.definitionName,
      stepKey: commission.stepKey,
      [STEP_AGENT_CONTEXT_KEY]: true,
    },
  });
  if (!run) return null;
  const runId = (run as { id: string }).id;
  // Visibility stamp — best-effort. The run is already commissioned, so a
  // failure to stamp is logged rather than surfaced as a commission failure.
  try {
    await db
      .update(heartbeatRuns)
      .set({ permissionMode: "governed", permissionProfile: permission.profile })
      .where(eq(heartbeatRuns.id, runId));
  } catch (err) {
    logger.error(
      { err, runId, issueId: commission.issueId },
      "step commission: failed to stamp permissionMode/permissionProfile on the commissioned run",
    );
  }
  return { runId };
}
