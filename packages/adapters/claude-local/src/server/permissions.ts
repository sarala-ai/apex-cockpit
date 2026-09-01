// Explicit allowlist of Claude Code tools we permit when running on a remote
// target. We use this instead of `--dangerously-skip-permissions` for remote
// targets because the permission-approval prompts can't be answered by a
// human inside a non-interactive run, but blanket-allowing every tool would
// defeat the point of having a separate hosted/sandbox code path.
//
// Maintenance: this list must be reviewed when Claude Code releases a new
// tool. The canonical list of built-in tools is documented at
// https://docs.claude.com/en/docs/claude-code/built-in-tools — when a tool
// is added there, decide whether it should be allowed in remote runs and
// either add it here or document the deliberate exclusion. Omitting a tool
// silently disables it inside remote targets, which can look like the tool is
// "broken" rather than intentionally gated.
// Exported (not just module-local) so the step run-policy module
// (server/src/apex/steps/run-policy.ts) can reuse the exact same grammar for
// its "bounded" permission profile instead of hand-maintaining a second copy
// that silently drifts from this one.
export const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

/**
 * Thrown by the launch-time guard (see `assertExplicitPermissionDecision`)
 * when a run reaches the adapter carrying no explicit permission decision.
 * A distinct class so callers/tests can assert the refusal precisely rather
 * than string-matching a generic Error.
 */
export class MissingPermissionDecisionError extends Error {
  readonly agentId: string;
  readonly agentName: string;
  constructor(agent: { id: string; name: string }) {
    super(
      `Refusing to launch claude_local run for agent "${agent.name}" (${agent.id}): ` +
        `its run config carries no explicit permission decision. A dispatched run must ` +
        `carry one — set adapterConfig.dangerouslySkipPermissions to true or false, or ` +
        `pass an explicit allowedTools grant. Failing closed instead of inheriting the ` +
        `dangerouslySkipPermissions=true default, which would silently grant full bypass ` +
        `to a run no permission profile ever governed.`,
    );
    this.name = "MissingPermissionDecisionError";
    this.agentId = agent.id;
    this.agentName = agent.name;
  }
}

/**
 * Does this run config carry an EXPLICIT permission decision?
 *
 * "Explicit" means a human or a policy actually decided, rather than the run
 * inheriting the adapter's silent `dangerouslySkipPermissions=true` default
 * (see execute.ts, `asBoolean(config.dangerouslySkipPermissions, true)`).
 * Either of two shapes counts:
 *   - `dangerouslySkipPermissions` present as a boolean — a straight true/false
 *     decision (including an explicit `true`: "yes, bypass, I mean it").
 *   - a non-empty `allowedTools` string — a governed grant (skip=false plus a
 *     specific --allowedTools list, how the step run-policy expresses bounded
 *     permissions). This is a decision even if `dangerouslySkipPermissions`
 *     is absent, since a grant only exists because something computed it.
 */
export function hasExplicitPermissionDecision(config: Record<string, unknown>): boolean {
  if (typeof config.dangerouslySkipPermissions === "boolean") return true;
  if (typeof config.allowedTools === "string" && config.allowedTools.trim().length > 0) return true;
  return false;
}

/**
 * Fail-closed guard invoked where a claude_local run actually launches
 * (execute.ts). `derivePermissionPolicy` is consulted by only the two
 * step-commission callers; every other dispatch path (routine wakeups,
 * operator edits, agents created outside the roster) reaches the adapter
 * directly and, without this, inherits the unsafe bypass default. Refuse
 * such a run rather than launch it undecided, and name the agent so the
 * refusal is actionable.
 */
export function assertExplicitPermissionDecision(
  config: Record<string, unknown>,
  agent: { id: string; name: string },
): void {
  if (!hasExplicitPermissionDecision(config)) {
    throw new MissingPermissionDecisionError(agent);
  }
}

export function buildClaudeProbePermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
}): string[] {
  if (!input.dangerouslySkipPermissions) return [];
  // For remote targets, mirror the execution path: pass `--allowedTools`
  // with the curated allowlist instead of dropping the flag entirely. The
  // hello probe is a one-shot prompt that should never trigger a tool, but
  // if a future probe prompt does, we don't want Claude CLI to stall on an
  // interactive permission prompt that no human can answer.
  if (input.targetIsRemote) return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  return ["--dangerously-skip-permissions"];
}

export function buildClaudeExecutionPermissionArgs(input: {
  dangerouslySkipPermissions: boolean;
  targetIsRemote: boolean;
  /**
   * Explicit `--allowedTools` grant computed by a caller-owned policy (e.g.
   * the step run-policy for step-commissioned runs). Takes precedence over
   * the dangerouslySkipPermissions/targetIsRemote defaults below in either
   * direction — it is how a caller asks for governed permissions (skip=false
   * but specific tools pre-approved) that this function otherwise has no way
   * to express, since skip=false alone means "no --allowedTools flag, fall
   * back to Claude Code's normal interactive prompting" (unusable for an
   * unattended run — nothing can answer the prompt).
   */
  allowedToolsOverride?: string | null;
}): string[] {
  if (input.allowedToolsOverride) {
    return ["--allowedTools", input.allowedToolsOverride];
  }
  if (!input.dangerouslySkipPermissions) return [];
  if (input.targetIsRemote) {
    return ["--allowedTools", SANDBOX_ALLOWED_TOOLS];
  }
  return ["--dangerously-skip-permissions"];
}
