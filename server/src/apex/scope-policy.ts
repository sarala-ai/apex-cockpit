// The single scope-authorization seam (apex-tower governance posture).
//
// ONE decision point that BOTH binding mutations (write scope bindings, change
// posture, create a company) AND display/reads (list/read projects, repos,
// bindings) route through — so posture/role logic lives in one place, not
// scattered `posture===… && role===…` checks across routes.
//
// This is now a THIN ADAPTER, not a parallel authz matrix:
//   - `individual` posture is the loose self-service end — single owner,
//     all-allow, no read filtering. Decided here (no engine round-trip needed).
//   - `team`/`enterprise` delegate the actual role/permission decision to the
//     fork's real authorization engine (authorizationService.authorizeOrgScope),
//     which reads org_memberships + honours instance-admin. The caller
//     (decideScope in apex-scoping.ts) resolves the engine `AuthorizationDecision`
//     and passes it in; this seam maps it to {allow, reason, visibility,
//     scopeFilter}. All "who can do what" now comes from ONE engine.
//
// Read-filtering: engine `allow` → full visibility today. Per-role SCOPED reads
// (reviewer/observer seeing a subset) need a defined data-visibility model;
// `scopeFilter` stays identity until that lands (flagged, not faked).

import type { AuthorizationDecision } from "../services/authorization.js";

export type GovernancePosture = "individual" | "team" | "enterprise";

export function isGovernancePosture(v: unknown): v is GovernancePosture {
  return v === "individual" || v === "team" || v === "enterprise";
}

export type ScopeAction =
  | "binding.read"
  | "binding.write"
  | "posture.read"
  | "posture.write"
  | "discovery.read"
  // Create a company under an org — a write (owner/admin in team/enterprise,
  // all-allow under individual).
  | "company.create";

/** Whether a scope action only reads (vs. mutates). Drives the read/write split
 *  both here and when mapping to the engine's org_scope:read / org_scope:write. */
export function isReadScopeAction(action: ScopeAction): boolean {
  return action === "binding.read" || action === "posture.read" || action === "discovery.read";
}

export interface ScopePolicyInput {
  /** The org's governance posture (defaults to individual when unknown). */
  posture: GovernancePosture;
  action: ScopeAction;
  /**
   * The engine's decision for this action, REQUIRED for `team`/`enterprise`.
   * Produced by `authorizationService(db).authorizeOrgScope(...)` in the caller,
   * so authority lives in the real engine, not here. Ignored for `individual`.
   */
  engineDecision?: AuthorizationDecision;
}

export interface ScopePolicyDecision {
  allow: boolean;
  /** Human-readable reason (surfaced on 403s / logged). */
  reason: string;
  /** How much the actor may SEE for read actions. */
  visibility: "all" | "scoped" | "none";
  /** Applied by callers to read results so display is governed by the same seam.
   *  Identity (no-op) today; per-role scoped filtering is future work. */
  scopeFilter: <T>(items: T[]) => T[];
}

const identityFilter = <T>(items: T[]): T[] => items;

/**
 * The one authorization decision. Pure — `individual` is decided here; for
 * `team`/`enterprise` the caller supplies the engine `AuthorizationDecision`
 * and this maps it onto the seam's {allow, visibility, scopeFilter} shape.
 */
export function authorizeScope(input: ScopePolicyInput): ScopePolicyDecision {
  const { posture, action } = input;

  // INDIVIDUAL — loose, self-service. Single owner, everything allowed, nothing
  // filtered. No engine round-trip.
  if (posture === "individual") {
    return {
      allow: true,
      reason: "individual posture — self-service, all-allow",
      visibility: "all",
      scopeFilter: identityFilter,
    };
  }

  // TEAM / ENTERPRISE — authority comes from the fork's engine. The caller must
  // pass the engine decision; without it we fail closed rather than re-deciding
  // locally (which would resurrect the parallel matrix this seam removed).
  const decision = input.engineDecision;
  if (!decision) {
    return {
      allow: false,
      reason: `${posture} posture — engine authorization decision required`,
      visibility: "none",
      scopeFilter: identityFilter,
    };
  }

  return {
    allow: decision.allowed,
    reason: decision.explanation,
    // Read allowed → full visibility for now; denied → none. Scoped read-
    // filtering (reviewer/observer subset) is deferred until a data-visibility
    // model exists — see file header.
    visibility: decision.allowed ? "all" : "none",
    scopeFilter: identityFilter,
  };
}
