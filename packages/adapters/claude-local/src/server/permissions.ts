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
// Exported (not just module-local) so the flow run-policy module
// (server/src/apex/flow/run-policy.ts) can reuse the exact same grammar for
// its "bounded" permission profile instead of hand-maintaining a second copy
// that silently drifts from this one.
export const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

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
   * the flow run-policy for flow-commissioned runs). Takes precedence over
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
