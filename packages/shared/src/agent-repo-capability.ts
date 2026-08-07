/**
 * CAN THIS AGENT CHANGE A REPOSITORY?
 *
 * One question, asked at three different moments by three different surfaces,
 * and it has to get the same answer at all three or the product lies to
 * somebody:
 *
 *   - the composer, before the ticket exists ("you are about to commission
 *     someone who will need code, and this ticket has none"),
 *   - the dispatch preconditions, at launch (server/src/services/heartbeat.ts),
 *   - the run policy, when it builds the grant (server/src/apex/steps/run-policy.ts).
 *
 * ── DERIVED FROM THE GRANT, NOT FROM A LIST OF NAMES ──
 *
 * The answer is read off the agent's EFFECTIVE `adapterConfig.allowedTools`
 * string — the same `--allowedTools` value the adapter will actually launch
 * with. Not from the agent's name, not from its role, and not from a hardcoded
 * roster of "the coding agents", because every one of those is a claim that
 * can drift from what the run is permitted to do. The grant cannot drift from
 * itself.
 *
 * That also means this works for agents nobody wrote a rule for: a company's
 * own agent, an operator-edited one, a future roster entry. It writes repos if
 * and only if its grant says it may.
 *
 * ── AN ABSENT GRANT MEANS YES, NOT NO ──
 *
 * The dangerous case, and the one worth being loud about: on a local coding
 * adapter, NO `allowedTools` and NO `dangerouslySkipPermissions` decision does
 * not mean "restricted" — it means the adapter falls back to skipping every
 * permission check (see MissingPermissionDecisionError in the claude-local
 * adapter, and DISPATCH_PRECONDITION_NO_PERMISSION_DECISION_REASON). An
 * ungoverned agent is the MOST capable one, so absence must read as "yes, it
 * writes repos" here. Reading absence as "no" would suppress the codebase
 * warning on exactly the runs that most need it.
 */

/**
 * Local coding adapters — the ones that launch a model inside a working
 * directory and can change what is in it. Kept in sync with
 * GIT_SENSITIVE_LOCAL_ADAPTER_TYPES in server/src/services/heartbeat.ts, which
 * scopes the workspace-validation and push-capability checks (both about the
 * checkout an adapter operates in); an adapter absent from both has no checkout
 * to miss. The no-codebase dispatch precondition is scoped by THIS function
 * instead, because "will this run write code?" is a narrower question than "is
 * this a coding adapter?" — a read-only agent on a coding adapter needs
 * repositories readable, not a project workspace to modify.
 */
export const REPO_CAPABLE_LOCAL_ADAPTER_TYPES: readonly string[] = [
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "grok_local",
  "hermes_local",
  "opencode_local",
  "pi_local",
];

/**
 * Native tool names that can modify files on disk.
 *
 * `Bash` counts, and unscoped is the only form that does: the grant grammar
 * lets a profile allow `Bash(git log:*)` without allowing `Bash`, and the
 * read-repos profile relies on exactly that distinction. A bare `Bash` token
 * is a shell, and a shell writes.
 */
const REPO_WRITE_TOOL_NAMES = ["Write", "Edit", "NotebookEdit", "Bash"];

/** Whether an `--allowedTools` grant string permits changing files. */
export function allowedToolsGrantRepositoryWrite(allowedTools: string): boolean {
  const tokens = allowedTools.split(/\s+/).filter((token) => token.length > 0);
  return tokens.some((token) => REPO_WRITE_TOOL_NAMES.includes(token));
}

/**
 * Whether commissioning this agent means commissioning something that will
 * need a checkout.
 *
 * Returns `false` for adapters that are not local coding adapters at all —
 * they have no working directory in the sense this question is about.
 */
export function agentWritesRepositories(agent: {
  adapterType: string;
  adapterConfig?: Record<string, unknown> | null;
}): boolean {
  if (!REPO_CAPABLE_LOCAL_ADAPTER_TYPES.includes(agent.adapterType)) return false;
  const allowedTools = agent.adapterConfig?.allowedTools;
  if (typeof allowedTools === "string" && allowedTools.trim().length > 0) {
    return allowedToolsGrantRepositoryWrite(allowedTools);
  }
  // No grant expressed. See the module doc: on these adapters that is full
  // bypass, not restriction.
  return true;
}
