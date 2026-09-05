/**
 * The Veil registry.
 *
 * A new company starts with almost nothing to look at: most nav surfaces are
 * "veiled" until the facts on the ground make them relevant (a repo is bound,
 * a run has started, a PR is open, ...). This file is the single source of
 * truth for what surfaces exist, which IA section they live in, and the rule
 * that decides when each one becomes DUE to unveil itself.
 *
 * `SURFACES` is pure data + pure functions — no DB, no request context. The
 * facts it reads (`OrgFacts`) are computed elsewhere (server/src/services/
 * org-facts.ts) and handed in; `due()` never does I/O.
 *
 * Routes are prefixes taken verbatim from ui/src/App.tsx's route table, not
 * reinvented here — see that file when a route is renamed.
 */

/** The five-plane IA plus the always-visible top row and standalone settings. */
export const SURFACE_SECTIONS = [
  "top",
  "work",
  "product",
  "operations",
  "governance",
  "agents",
  "settings",
] as const;
export type SurfaceSection = (typeof SURFACE_SECTIONS)[number];

/** Stage a surface belongs to in the reveal ladder (1 = present from day one). */
export type SurfaceStage = 1 | 2 | 3 | 4 | 5;

/** The flattened, failure-isolated snapshot `due()` rules read. Computed by
 *  server/src/services/org-facts.ts — one field per independently-probed
 *  source, never a nested probe result (a rule should never need to know
 *  where a fact came from, only what it is). */
export interface OrgFacts {
  /** ISO timestamp this snapshot was assembled. */
  asOf: string;
  /** At least one repo or GCP project bound at org or company scope. */
  hasRepoOrCloudBinding: boolean;
  /** At least one heartbeat run has ever been started for this org. */
  runsStarted: number;
  /** Runs that reached a terminal (non-running) status. */
  runsCompleted: number;
  /** Timestamp of the first run ever started, if any. */
  firstRunAt: string | null;
  /** Runs currently in flight. */
  liveRunCount: number;
  /** Open pull requests tracked against this org's pipeline cases. */
  openPrCount: number;
  /** Releases that have actually shipped (releasedAt is set). */
  deploysLanded: number;
  /** A gateway (MCP) call has been audited for this org. */
  gatewayCallAudited: boolean;
  /** Org-level membership count (people, not agents). */
  orgMemberCount: number;
  /** Company-level membership count, summed across this org's companies. */
  companyMemberCount: number;
  /** Goals/initiatives that exist for this org's companies. */
  goalCount: number;
  /** The signed-in operator's workstation report (or, on a local instance,
   *  the server's own probe) shows a healthy, non-stale gcloud/gh posture. */
  operatorAuthHealthy: boolean;
}

/** A surface's due() verdict: whether the registry considers it relevant yet,
 *  and a human-readable reason (shown in the UI, logged in flag events). */
export interface SurfaceDueResult {
  due: boolean;
  reason: string;
}

export interface SurfaceDef {
  key: string;
  label: string;
  section: SurfaceSection;
  /** Route prefixes (relative to the board root, e.g. "issues") this surface
   *  covers — taken from ui/src/App.tsx's route table. */
  routes: string[];
  /** Where the nav link should point when rendered. */
  navPath: string;
  stage: SurfaceStage;
  /** Never veiled — always considered due regardless of facts. Only `chat`
   *  carries this today. */
  always?: boolean;
  /** Pure function of the facts snapshot. Never does I/O. */
  due: (facts: OrgFacts) => SurfaceDueResult;
}

const NOT_DUE = (reason: string): SurfaceDueResult => ({ due: false, reason });
const DUE = (reason: string): SurfaceDueResult => ({ due: true, reason });

/** Stage 2: a repo or cloud project has been bound at org or company scope. */
function dueOnBinding(facts: OrgFacts): SurfaceDueResult {
  return facts.hasRepoOrCloudBinding
    ? DUE("a repo or cloud project is bound")
    : NOT_DUE("no repo or cloud project bound yet");
}

/** Stage 3: the first run has been started. */
function dueOnFirstRun(facts: OrgFacts): SurfaceDueResult {
  return facts.runsStarted > 0
    ? DUE("the first run has started")
    : NOT_DUE("no run has started yet");
}

/** Timeline/Workspaces: due once a *second* run has started — the surfaces
 *  that only make sense once there is something to compare across runs. */
function dueOnSecondRun(facts: OrgFacts): SurfaceDueResult {
  return facts.runsStarted > 1
    ? DUE("a second run has started")
    : NOT_DUE("fewer than two runs have started");
}

/** Stage 4: a PR is open against this org's work. */
function dueOnOpenPr(facts: OrgFacts): SurfaceDueResult {
  return facts.openPrCount > 0
    ? DUE("a pull request is open")
    : NOT_DUE("no pull request is open yet");
}

/** Observe/Costs/Gateway: due once a deploy has landed OR a gateway call has
 *  been audited — either is evidence something real ran end to end. */
function dueOnDeployOrGatewayAudit(facts: OrgFacts): SurfaceDueResult {
  if (facts.deploysLanded > 0) return DUE("a deploy has landed");
  if (facts.gatewayCallAudited) return DUE("a gateway call has been audited");
  return NOT_DUE("no deploy has landed and no gateway call has been audited");
}

/** Stage 5: due once at least two runs have COMPLETED — "by request" (an
 *  explicit unveil) is handled by the service layer, not by this rule. */
function dueOnCompletedRuns(facts: OrgFacts): SurfaceDueResult {
  return facts.runsCompleted >= 2
    ? DUE("at least two runs have completed")
    : NOT_DUE("fewer than two runs have completed");
}

/** Settings is never gated by facts — it stays veiled by default and is
 *  revealed only by an explicit unveil (chat/api/user), never by a rule. */
function neverDue(): SurfaceDueResult {
  return NOT_DUE("settings is never auto-unveiled by rule");
}

export const SURFACES: SurfaceDef[] = [
  // --- Top row -------------------------------------------------------
  { key: "chat", label: "Chat", section: "top", routes: ["board-chat"], navPath: "/board-chat", stage: 1, always: true, due: () => DUE("always visible") },
  { key: "dashboard", label: "Dashboard", section: "top", routes: ["dashboard"], navPath: "/dashboard", stage: 1, due: () => DUE("present from day one") },
  { key: "inbox", label: "Inbox", section: "top", routes: ["inbox"], navPath: "/inbox", stage: 3, due: dueOnFirstRun },

  // --- Work plane ------------------------------------------------------
  { key: "tasks", label: "Tasks", section: "work", routes: ["issues"], navPath: "/issues", stage: 3, due: dueOnFirstRun },
  { key: "projects", label: "Projects", section: "work", routes: ["projects"], navPath: "/projects", stage: 2, due: dueOnBinding },
  { key: "artifacts", label: "Artifacts", section: "work", routes: ["artifacts"], navPath: "/artifacts", stage: 3, due: dueOnFirstRun },
  { key: "timeline", label: "Timeline", section: "work", routes: ["timeline"], navPath: "/timeline", stage: 3, due: dueOnSecondRun },
  { key: "workspaces", label: "Workspaces", section: "work", routes: ["workspaces"], navPath: "/workspaces", stage: 3, due: dueOnSecondRun },
  { key: "routines", label: "Routines", section: "work", routes: ["routines"], navPath: "/routines", stage: 3, due: dueOnFirstRun },
  { key: "cases", label: "Cases", section: "work", routes: ["cases"], navPath: "/cases", stage: 3, due: dueOnFirstRun },
  { key: "pipelines", label: "Pipelines", section: "work", routes: ["pipelines"], navPath: "/pipelines", stage: 4, due: dueOnOpenPr },

  // --- Settings-scoped surfaces (routed under company/settings) --------
  { key: "secrets", label: "Secrets", section: "settings", routes: ["company/settings/secrets"], navPath: "/company/settings/secrets", stage: 2, due: dueOnBinding },
  {
    key: "environments",
    label: "Environments",
    section: "settings",
    routes: ["company/settings/instance/environments", "company/settings/environments"],
    navPath: "/company/settings/instance/environments",
    stage: 2,
    due: dueOnBinding,
  },
  { key: "settings", label: "Settings", section: "settings", routes: ["company/settings"], navPath: "/company/settings", stage: 1, due: neverDue },

  // --- Product plane -----------------------------------------------------
  { key: "design", label: "Design", section: "product", routes: ["design"], navPath: "/design", stage: 1, due: () => DUE("present from day one") },
  { key: "goals", label: "Goals", section: "product", routes: ["goals"], navPath: "/goals", stage: 1, due: () => DUE("present from day one") },
  { key: "proposals", label: "Proposals", section: "product", routes: ["proposals"], navPath: "/proposals", stage: 1, due: () => DUE("present from day one") },

  // --- Operations plane ----------------------------------------------------
  { key: "releases", label: "Releases", section: "operations", routes: ["releases"], navPath: "/releases", stage: 4, due: dueOnOpenPr },
  { key: "approvals", label: "Approvals", section: "operations", routes: ["approvals"], navPath: "/approvals/pending", stage: 4, due: dueOnOpenPr },
  { key: "observe", label: "Observe", section: "operations", routes: ["observe"], navPath: "/observe", stage: 4, due: dueOnDeployOrGatewayAudit },
  { key: "costs", label: "Costs", section: "operations", routes: ["costs"], navPath: "/costs", stage: 4, due: dueOnDeployOrGatewayAudit },
  { key: "activity", label: "Activity", section: "operations", routes: ["activity"], navPath: "/activity", stage: 3, due: dueOnFirstRun },

  // --- Governance plane ------------------------------------------------
  { key: "gateway", label: "Gateway", section: "governance", routes: ["gateway"], navPath: "/gateway", stage: 4, due: dueOnDeployOrGatewayAudit },
  { key: "skills", label: "Skills", section: "governance", routes: ["skills"], navPath: "/skills", stage: 5, due: dueOnCompletedRuns },
  { key: "prompts", label: "Prompts", section: "governance", routes: ["prompts"], navPath: "/prompts", stage: 5, due: dueOnCompletedRuns },
  { key: "workflows", label: "Workflows", section: "governance", routes: ["workflows"], navPath: "/workflows", stage: 5, due: dueOnCompletedRuns },

  // --- Agents plane ------------------------------------------------------
  { key: "agents", label: "Agents", section: "agents", routes: ["agents"], navPath: "/agents/all", stage: 1, due: () => DUE("present from day one") },
  // No route yet — the nav lane (Sidebar.tsx) that would wire this surface up
  // is explicitly deferred; the registry key exists so facts/flags can be
  // tracked ahead of that UI landing.
  { key: "teams", label: "Teams", section: "agents", routes: [], navPath: "/agents/all", stage: 5, due: dueOnCompletedRuns },
];

export function getSurface(key: string): SurfaceDef | undefined {
  return SURFACES.find((s) => s.key === key);
}
