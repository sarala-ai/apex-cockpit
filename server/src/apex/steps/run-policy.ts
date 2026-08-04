/**
 * Permission policy for FLOW-COMMISSIONED agent runs (founder-approved
 * design, see server/src/apex/flow/coordinator.ts).
 *
 * The problem this closes: the claude_local adapter defaults
 * `dangerouslySkipPermissions=true` for local execution targets
 * (packages/adapters/claude-local/src/server/execute.ts, `asBoolean(config.
 * dangerouslySkipPermissions, true)`) — a reasonable default for a human
 * sitting at the keyboard who can answer a permission prompt, but wrong for
 * a run the flow coordinator commissions unattended off a heartbeat wakeup
 * (server/src/apex/flow/coordinator.ts `defaultCommissionAgentRun`): nothing
 * is present to answer an interactive prompt, and full bypass on a
 * self-directed run is a needlessly large blast radius. Interactive,
 * human-started runs are NOT touched by anything in this module — this is
 * additive governance for the flow-commissioned path only.
 *
 * Profiles (declared per agent node under `permissions.profile` — see the
 * core-schema note below):
 *   - "bounded" (DEFAULT): workspace-scoped native tools. No
 *     dangerously-skip-permissions; an explicit --allowedTools grant is
 *     passed instead (see nativeTools below).
 *   - "read-only-broad": broad native READ tools, zero write/network — for
 *     agent nodes whose job is declared diagnostics (inspect and report,
 *     never mutate).
 *   - "read-repos": the read-only tools PLUS Bash scoped to read-only VCS
 *     commands (git log/show/diff/…, gh pr view/issue view/…). For an agent
 *     whose job is to reconstruct what happened from the record — commits,
 *     pull requests, releases — which Glob/Grep/Read cannot reach, because
 *     history is not a file.
 *
 * nativeTools grammar: derived from the exact precedent the claude_local
 * adapter already uses for its remote-execution path — a space-separated
 * Claude Code --allowedTools list
 * (packages/adapters/claude-local/src/server/permissions.ts,
 * SANDBOX_ALLOWED_TOOLS). "bounded" reuses that constant verbatim (single
 * source of truth — the adapter module's own comment already flags it needs
 * review whenever Claude Code ships a new built-in tool; a second
 * hand-maintained copy here would just be a second place to forget).
 *
 * ── WHAT --allowedTools ACTUALLY GATES (measured, not assumed) ──
 *
 * This module previously asserted that the grammar "gates by *tool name*, not
 * by filesystem path", and used that to justify aliasing "read-repos" to
 * "read-only-broad". Half of it was wrong, and the wrong half was load-bearing:
 * the CLI DOES honour per-command scoping inside the tool name.
 *
 * Measured against Claude Code 2.1.220, `--permission-mode default`, `-p`, same
 * prompt, same cwd:
 *
 *   --allowedTools "Bash(git log:*) Read"  →  "touch scope-a.tmp"  DENIED, no file
 *   --allowedTools "Bash Read"             →  "touch scope-b.tmp"  ran, file created
 *   --allowedTools "Bash(git log:*) …"     →  "git commit --allow-empty"  DENIED
 *   --allowedTools "… Bash(gh pr list:*)"  →  "gh pr list --limit 1"  ran
 *
 * So a scoped grant is real enforcement, and the space inside `Bash(git log:*)`
 * survives the space-separated grant string intact (the adapter passes the
 * whole string as ONE argv element — see buildClaudeExecutionPermissionArgs).
 *
 * Two limits that remain true and are NOT papered over:
 *   - Scoping is by COMMAND PREFIX, not by filesystem path. "workspace-scoped"
 *     for Read/Glob/Grep is still a cwd convention, not a boundary the CLI
 *     enforces. A read-only grant can read anything on the machine it is
 *     pointed at, including a checkout's untracked .env — see the
 *     workspace-fetch posture note below.
 *   - A prefix cannot express an HTTP method, which is why `gh api` is NOT in
 *     the read-repos grant: `Bash(gh api:*)` would also permit
 *     `gh api -X POST`, i.e. a write. Read-only `gh` verbs are listed one by
 *     one instead. If a future run genuinely needs `gh api` GETs, it needs a
 *     narrower matcher or a wrapper, not a looser prefix.
 *
 * apex/MCP tools: whatever the node declares under `permissions.mcpTools`
 * (array of literal tool identifiers, e.g. "mcp__github__create_pr") passes
 * through verbatim — this module does not invent an MCP allowlist. Broad-read
 * default note: when a node declares no mcpTools, v1 does NOT narrow the
 * gateway's configured MCP surface (whatever `--mcp-config` wires stays
 * available) — there is no per-run MCP tool gate today, only the native
 * --allowedTools gate above. Declaring mcpTools here is recorded (surfaced on
 * the run) but not yet enforced; follow-up alongside the path-scoping gap.
 *
 * ── SCOPE OF THIS MODULE, STATED PLAINLY ──
 *
 * Everything here applies to FLOW-COMMISSIONED runs only (commission.ts and
 * flow/coordinator.ts are its only two callers). A ROUTINE-triggered run of the
 * same agent does NOT pass through here and gets the adapter's own default,
 * which is full bypass. An agent whose blast radius must hold on every run
 * therefore carries the grant on its own adapterConfig
 * (`dangerouslySkipPermissions: false` + `allowedTools`) — the seam
 * execute.ts already reads — and the roster sets that from the same constants
 * below, so the two cannot drift.
 *
 * Workspace-fetch posture (documentation only, no machinery this session):
 * the founder-decided default is that an unattended flow-commissioned run
 * needing repo *content* should fetch a pinned ref into the run's own
 * workspace rather than read a human's local checkout directly — a local
 * checkout routinely carries untracked files (.env, credentials, scratch
 * secrets) that a bounded or read-only-broad grant would otherwise expose
 * wholesale via the Read/Glob/Grep tools. Tracked-files-only local reads
 * (walk the checkout but only what git tracks) is a plausible middle ground
 * for a future refinement, but is NOT implemented — v1 has no fetch
 * machinery at all; this paragraph is the recorded intent for whoever builds
 * it.
 *
 * Core-side follow-up (NOT done here, core is out of scope for this
 * change): apex-core's `flow_models.AgentNodeConfig` (pydantic) needs a
 * `permissions` field added so `apex flows show --output json` actually
 * emits what a flow YAML author declares. Until then, this module's read of
 * `node.agent.permissions` is tolerant-not-contractual (see definition.ts's
 * `agentNodeConfigSchema.permissions: z.unknown().nullish()`) — it will
 * pick up the field the moment core emits it, but nothing here depends on
 * core actually doing so yet.
 */
import { SANDBOX_ALLOWED_TOOLS } from "@paperclipai/adapter-claude-local/server";

export const PERMISSION_PROFILES = ["bounded", "read-only-broad", "read-repos"] as const;
export type PermissionProfile = (typeof PERMISSION_PROFILES)[number];

export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = "bounded";

/** Broad native READ tools only — no Edit/Write/Bash, no WebFetch/WebSearch
 *  (zero write, zero network). Used for "read-only-broad" and (v1) aliased
 *  "read-repos". Kept local (not adapter-exported): unlike SANDBOX_ALLOWED_
 *  TOOLS this isn't an existing adapter precedent, it's this policy's own
 *  derived subset of the same tool-name grammar. */
export const READ_ONLY_BROAD_ALLOWED_TOOLS =
  "AskUserQuestion Glob Grep Monitor Read TaskOutput TaskStop ToolSearch";

/**
 * Read-only tools PLUS the VCS history commands, each scoped to its own
 * read-only verb.
 *
 * Why this profile has to exist at all: an agent asked to reconstruct what a
 * product did cannot do it from files. What shipped and when, what was
 * reverted, what a reviewer objected to — that is commits, pull requests and
 * releases, and Glob/Grep/Read reach none of it. A "repo reader" without
 * `git log` is a scanning agent that cannot scan.
 *
 * Every entry is a verb that cannot mutate a repository, a remote or the
 * machine. Deliberately ABSENT, each for a reason worth keeping:
 *   - `git branch`, `git tag`, `git config` — read in one form, write in
 *     another (`git branch -D`), and a prefix matcher cannot tell them apart.
 *   - `git checkout`, `git fetch`, `git pull`, `git stash` — mutate the
 *     working tree or the object store even when they look like navigation.
 *   - `gh api` — see the module doc: a prefix cannot express "GET only".
 *   - `gh pr create/merge/comment`, `gh issue create` — writes, obviously, and
 *     absent because the ONLY write this agent has is a proposal.
 */
export const READ_REPOS_ALLOWED_TOOLS = [
  READ_ONLY_BROAD_ALLOWED_TOOLS,
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git rev-list:*)",
  "Bash(git rev-parse:*)",
  "Bash(git describe:*)",
  "Bash(git blame:*)",
  "Bash(git shortlog:*)",
  "Bash(git ls-files:*)",
  "Bash(git ls-tree:*)",
  "Bash(git cat-file:*)",
  "Bash(git grep:*)",
  "Bash(gh pr list:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh issue list:*)",
  "Bash(gh issue view:*)",
  "Bash(gh release list:*)",
  "Bash(gh release view:*)",
  "Bash(gh run list:*)",
  "Bash(gh run view:*)",
].join(" ");

export type RunPermissionPolicy = {
  profile: PermissionProfile;
  /** Always "governed" — this module only ever produces the governed
   *  side of the mode; "bypass" is the adapter's pre-existing default and
   *  is never something this module asks for. */
  permissionMode: "governed";
  /** Space-separated Claude Code --allowedTools grant (adapter grammar). */
  nativeTools: string;
  /** Verbatim pass-through of the node's declared MCP tool identifiers.
   *  Empty means "no narrowing" — see module doc's broad-read default note. */
  mcpTools: string[];
  /** Non-fatal notes about this policy derivation worth surfacing in logs —
   *  e.g. "unrecognized profile, fell back to bounded", or the read-repos
   *  aliasing notice. Never throws; garbage input degrades to a note plus
   *  the safe default, not an error. */
  notes: string[];
};

/**
 * The native-tool grant a profile means, as one string.
 *
 * Exported because a profile is only a claim until something applies it, and
 * this module is read at FLOW-commission time ONLY (`derivePermissionPolicy`
 * has two callers). A routine-triggered run never reaches it and would inherit
 * the adapter's `dangerouslySkipPermissions: true` default — so an agent
 * declared read-only could write files on the path that matters most. The
 * roster carries the same grant on each agent's own `adapterConfig`, and takes
 * it from HERE so the two can never drift.
 */
export function nativeToolsForProfile(profile: PermissionProfile): string {
  switch (profile) {
    case "bounded":
      return SANDBOX_ALLOWED_TOOLS;
    case "read-only-broad":
      return READ_ONLY_BROAD_ALLOWED_TOOLS;
    case "read-repos":
      return READ_REPOS_ALLOWED_TOOLS;
  }
}

/**
 * Whether a profile can CHANGE A REPOSITORY — the one question a ticket has to
 * answer before it commissions anybody, because an agent that will write code
 * and has no checkout to write it in is the failure this whole preflight
 * exists to prevent.
 *
 * Only `bounded` grants Edit/Write/Bash (see `nativeToolsForProfile`).
 * `read-only-broad` has no write verb at all and `read-repos` adds only
 * read-only VCS commands — an agent under either can be asked a question about
 * a codebase, but never dispatched to change one, so neither makes a repo
 * binding a precondition. Derived from the profile rather than from a list of
 * agent names, so a new agent inherits the right answer by declaring a
 * profile and nothing has to be remembered.
 */
export function permissionProfileWritesRepositories(profile: PermissionProfile): boolean {
  return profile === "bounded";
}

function isPermissionProfile(value: unknown): value is PermissionProfile {
  return typeof value === "string" && (PERMISSION_PROFILES as readonly string[]).includes(value);
}

/** Tolerant read of a node's raw `permissions` config (whatever shape shows
 *  up — see module doc's core-side follow-up) into a concrete policy. Never
 *  throws: anything unrecognized degrades to the "bounded" default with a
 *  note explaining why, since a flow-commissioned run with no readable
 *  permission declaration should get the SAFEST default, not the loosest. */
export function derivePermissionPolicy(rawPermissions: unknown): RunPermissionPolicy {
  const notes: string[] = [];
  const raw =
    typeof rawPermissions === "object" && rawPermissions !== null && !Array.isArray(rawPermissions)
      ? (rawPermissions as Record<string, unknown>)
      : null;
  if (rawPermissions !== null && rawPermissions !== undefined && raw === null) {
    notes.push(
      `node declared a non-object 'permissions' value (${typeof rawPermissions}) — ignored, using default profile`,
    );
  }

  const declaredProfile = raw?.profile;
  let profile: PermissionProfile = DEFAULT_PERMISSION_PROFILE;
  if (declaredProfile !== undefined) {
    if (isPermissionProfile(declaredProfile)) {
      profile = declaredProfile;
    } else {
      notes.push(
        `node declared unrecognized permissions.profile '${String(declaredProfile)}' — falling back to '${DEFAULT_PERMISSION_PROFILE}'`,
      );
    }
  }
  if (profile === "read-repos") {
    // The grant is real (Bash scoped per read-only VCS verb, measured against
    // the CLI — see module doc). The note that remains is the honest residue:
    // the READS themselves are not path-scoped, so this profile bounds what the
    // run can DO, not where it can look.
    notes.push(
      "profile 'read-repos' grants read-only VCS commands (git log/show/diff, gh pr/issue/release view) " +
        "and no write verbs; reads are NOT path-scoped — the run can read any file the process can reach",
    );
  }

  const rawMcpTools = raw?.mcpTools;
  const mcpTools = Array.isArray(rawMcpTools)
    ? rawMcpTools.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  if (rawMcpTools !== undefined && !Array.isArray(rawMcpTools)) {
    notes.push("node declared non-array permissions.mcpTools — ignored");
  }

  return {
    profile,
    permissionMode: "governed",
    nativeTools: nativeToolsForProfile(profile),
    mcpTools,
    notes,
  };
}

/**
 * Merge the governed permission override into an issue's existing
 * `assigneeAdapterOverrides.adapterConfig` (packages/db/src/schema/issues.ts)
 * — the fork's existing per-ISSUE (not per-agent-record, not global) adapter
 * config override seam, already merged into the effective run config by
 * `mergeModelProfileAdapterConfig` in server/src/services/heartbeat.ts
 * (`{...baseConfig, ...modelProfileAdapterConfig, ...issueAdapterConfig}` —
 * issue overrides win last). Only the two permission-relevant keys are
 * written; anything else a human already set on the issue (e.g. `model`) is
 * preserved untouched.
 */
export function applyGovernedAdapterConfigOverride(
  existingAdapterConfig: Record<string, unknown> | null | undefined,
  policy: RunPermissionPolicy,
): Record<string, unknown> {
  return {
    ...(existingAdapterConfig ?? {}),
    dangerouslySkipPermissions: false,
    allowedTools: policy.nativeTools,
  };
}

/**
 * Strip the governed permission override back out, once the flow reaches a
 * terminal status (done/failed — see coordinator.ts's markFailed and the
 * "done" branch of advanceOrComplete) and no further commissioning will read
 * this issue's override. Deliberately NOT called between a flow's own
 * sequential agent-node commissions: each commission overwrites both keys
 * fresh right before its own wakeup, so there is no window where a stale
 * profile from a previous node leaks into the next one. It is also
 * deliberately NOT called immediately after `wakeup()` returns — wakeup only
 * enqueues; the actual adapter config assembly happens later, when heartbeat
 * dispatches the run, so restoring synchronously would race the override out
 * from under the run it was set for. Clearing only at flow-terminal is the
 * safe boundary: every commission this flow will ever make for this issue
 * has already resolved by then.
 */
export function clearGovernedAdapterConfigOverride(
  existingAdapterConfig: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!existingAdapterConfig) return existingAdapterConfig ?? null;
  const { dangerouslySkipPermissions, allowedTools, ...rest } = existingAdapterConfig;
  void dangerouslySkipPermissions;
  void allowedTools;
  return Object.keys(rest).length > 0 ? rest : null;
}
