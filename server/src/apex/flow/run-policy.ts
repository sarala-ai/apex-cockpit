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
 *   - "read-repos": v1 ACCEPTS and RECORDS this profile (so flow authors can
 *     declare intent now) but ENFORCES it identically to "read-only-broad".
 *     True path-scoped enforcement (reads limited to the company's declared
 *     repo checkouts, nothing else on the machine) needs the execution
 *     adapter to accept a path allowlist, which it does not today — the
 *     adapter's --allowedTools grammar gates by *tool name*, not by
 *     filesystem path. TODO(follow-up): once an adapter exposes path-scoped
 *     read enforcement, tighten this profile instead of aliasing it.
 *
 * nativeTools grammar: derived from the exact precedent the claude_local
 * adapter already uses for its remote-execution path — a space-separated
 * Claude Code --allowedTools tool-name list
 * (packages/adapters/claude-local/src/server/permissions.ts,
 * SANDBOX_ALLOWED_TOOLS). "bounded" reuses that constant verbatim (single
 * source of truth — the adapter module's own comment already flags it needs
 * review whenever Claude Code ships a new built-in tool; a second
 * hand-maintained copy here would just be a second place to forget). Caveat
 * inherited from the adapter, not invented here: --allowedTools gates by
 * tool *name*, so "workspace-scoped" for Read/Bash is a documented intent
 * backed by the run's cwd convention, not a hard filesystem boundary the CLI
 * enforces — same limitation the read-repos TODO above calls out.
 *
 * apex/MCP tools: whatever the node declares under `permissions.mcpTools`
 * (array of literal tool identifiers, e.g. "mcp__github__create_pr") passes
 * through verbatim — this module does not invent an MCP allowlist. Broad-read
 * default note: when a node declares no mcpTools, v1 does NOT narrow the
 * gateway's configured MCP surface (whatever `--mcp-config` wires stays
 * available) — there is no per-run MCP tool gate today, only the native
 * --allowedTools gate above. Declaring mcpTools here is recorded (surfaced on
 * the run) but not yet enforced; follow-up alongside the read-repos TODO.
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

function nativeToolsForProfile(profile: PermissionProfile): string {
  switch (profile) {
    case "bounded":
      return SANDBOX_ALLOWED_TOOLS;
    case "read-only-broad":
    case "read-repos":
      return READ_ONLY_BROAD_ALLOWED_TOOLS;
  }
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
    notes.push(
      "profile 'read-repos' recorded but v1 enforces it identically to 'read-only-broad' " +
        "(path-scoped enforcement needs adapter support — see module doc TODO)",
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
