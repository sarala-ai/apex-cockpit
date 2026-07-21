// The single scope-authorization seam (apex-tower governance posture).
//
// ONE decision point that BOTH binding mutations (write scope bindings, change
// posture) AND display/reads (list/read projects, repos, bindings) route through,
// so the follow-up authorization pass extends the matrix in one place instead of
// chasing scattered `posture===… && role===…` checks across routes.
//
// It sits ON TOP of the fork's existing authz (assertBoardOrAgent / actor
// memberships / isInstanceAdmin) — the routes still do the coarse board/agent
// gate; this adds the posture × role factor and, for reads, a `scopeFilter` the
// caller applies to results (so DISPLAY is governed too, not just mutations).
//
// SCOPE OF THIS PASS: `individual` posture is implemented correctly (single owner,
// all-allow, no read filtering); `team`/`enterprise` are SCAFFOLDED (writes need
// owner/admin; reads allowed, no filtering yet). The full posture × role matrix +
// enterprise read-filtering land in the dedicated authorization pass — extend
// HERE, not in the routes.

export type GovernancePosture = "individual" | "team" | "enterprise";

export function isGovernancePosture(v: unknown): v is GovernancePosture {
  return v === "individual" || v === "team" || v === "enterprise";
}

/** Org membership role vocabulary (owner/admin/member; reviewer/observer reserved). */
export type ScopeRole = "owner" | "admin" | "member" | "reviewer" | "observer";

export type ScopeAction =
  | "binding.read"
  | "binding.write"
  | "posture.read"
  | "posture.write"
  | "discovery.read";

export interface ScopePolicyInput {
  /** The org's governance posture (defaults to individual when unknown). */
  posture: GovernancePosture;
  /** The actor's org-membership role, if any. */
  role?: string | null;
  /** Trusted local/instance admin — bypasses role checks (fork's existing notion). */
  isInstanceAdmin?: boolean;
  action: ScopeAction;
  scope?: { type: "org" | "company"; id?: string };
}

export interface ScopePolicyDecision {
  allow: boolean;
  /** Human-readable reason (surfaced on 403s / logged). */
  reason: string;
  /** How much the actor may SEE for read actions. */
  visibility: "all" | "scoped" | "none";
  /** Applied by callers to read results so display is governed by the same seam.
   *  Identity (no-op) for `individual` / `visibility:"all"`. */
  scopeFilter: <T>(items: T[]) => T[];
}

const identityFilter = <T>(items: T[]): T[] => items;

function isOwnerOrAdmin(role?: string | null, isInstanceAdmin?: boolean): boolean {
  return Boolean(isInstanceAdmin) || role === "owner" || role === "admin";
}

/**
 * The one authorization decision. Pure — callers resolve `{posture, role,
 * isInstanceAdmin}` (see resolveScopeContext in apex-scoping.ts) and pass the
 * action; the route enforces `allow` for writes and applies `scopeFilter` to
 * read results.
 */
export function authorizeScope(input: ScopePolicyInput): ScopePolicyDecision {
  const { posture, role, isInstanceAdmin, action } = input;

  // INDIVIDUAL — the loose, self-service end. Single owner, everything allowed,
  // nothing filtered. This is the fully-implemented path for this pass.
  if (posture === "individual") {
    return {
      allow: true,
      reason: "individual posture — self-service, all-allow",
      visibility: "all",
      scopeFilter: identityFilter,
    };
  }

  // TEAM / ENTERPRISE — SCAFFOLD. Writes need owner/admin; reads are allowed with
  // no filtering yet. The full posture × role matrix + enterprise read-filtering
  // (visibility:"scoped"/"none" + a real scopeFilter) are the authorization pass —
  // extend this block, keep the seam single.
  const isRead = action === "binding.read" || action === "posture.read" || action === "discovery.read";
  if (isRead) {
    return {
      allow: true,
      reason: `${posture} posture — read allowed (filtering not yet enforced)`,
      visibility: "all",
      scopeFilter: identityFilter,
    };
  }
  // Writes (binding.write / posture.write): owner/admin only.
  if (isOwnerOrAdmin(role, isInstanceAdmin)) {
    return {
      allow: true,
      reason: `${posture} posture — owner/admin write`,
      visibility: "all",
      scopeFilter: identityFilter,
    };
  }
  return {
    allow: false,
    reason: `${posture} posture — ${action} requires org owner/admin`,
    visibility: "none",
    scopeFilter: identityFilter,
  };
}
