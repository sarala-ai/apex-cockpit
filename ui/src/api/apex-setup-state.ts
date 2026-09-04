// Onboarding-wizard detector client (apex-tower).
//
// Talks to the Express `GET /api/setup/state` route (server/src/routes/apex-setup-state.ts),
// a single failure-isolated snapshot of every setup prerequisite the wizard renders
// as a live checklist. `orgId` scopes the company count/list to that org.

import { api } from "./client";

type Health = "ok" | "missing" | "expired";

export type ClaudeAuthMode = "subscription_local" | "subscription_remote" | "api_key" | "none" | "unknown";

/** Mirrors server/src/apex/model-access/index.ts ModelAccessState. */
export interface ModelAccessState {
  claude: {
    mode: ClaudeAuthMode;
    // null when neither the server nor a workstation report has an opinion.
    installed: boolean | null;
    // where the `installed`/`mode` facts came from — this cockpit host, or the
    // operator's workstation report. "unknown" = no report has ever landed.
    source: "server" | "workstation" | "unknown";
    reportedAt: string | null;
    subscriptionProviderRegistered: boolean;
    apiKeyProviderRegistered: boolean;
  };
  openrouter: { configured: boolean };
  aliasesRegistered: string[];
  // The local subscription bridge (backed by a `claude` CLI on THIS host) is
  // only available on a local cockpit — false on a hosted (Cloud Run) deployment.
  bridgeAvailable: boolean;
}

export interface SetupState {
  auth: {
    gcloud: Health;
    gh: Health;
    adc: Health;
    // "server" = the cockpit probed itself; "workstation" = the operator's
    // desktop app / `apex doctor --report` last reported (within the max
    // report age); "stale" = a workstation report exists but is older than
    // the server's max age — the gcloud/gh/adc values above are still carried
    // as reported, but must NOT be treated as green; "none" = unknown.
    source: "server" | "workstation" | "stale" | "none";
    reportedAt: string | null;
    /** Milliseconds since the workstation report; null for "server"/"none". */
    reportAgeMs: number | null;
  };
  /** `posture` is the governance dial (default `individual`). */
  org: { present: boolean; id?: string; posture?: "individual" | "team" | "enterprise" };
  /** The signed-in user's membership in the detected org (drives the wizard's
   *  bootstrap-owner / member / awaiting-approval branch). */
  membership: { role?: string; status?: string; present: boolean };
  companies: { count: number; ids: string[] };
  /** Cloud/repo binding presence, split by scope + kind (org-cloud vs
   *  company-cloud vs company-repos) so each spine step detects independently. */
  scoping: {
    orgProjectsBound: boolean;
    orgReposBound: boolean;
    companyProjectsBound: boolean;
    companyReposBound: boolean;
  };
  oauthClient: {
    /** The cockpit's own Google sign-in client (GOOGLE_CLIENT_ID). */
    configured: boolean;
    signInClient: "configured" | "missing" | "not_applicable";
    /** The gateway's OAuth-typed upstream registrations and how many carry an OAuth config. */
    gatewayUpstreams: { total: number; configured: number; error?: string };
    note?: string;
  };
  gateway: {
    reachable: boolean;
    url: string;
    /** null when unreachable — the credential could not even be tried. */
    authenticated: boolean | null;
    failure: {
      kind: "unauthenticated" | "forbidden" | "http" | "unreachable";
      message: string;
    } | null;
  };
  /** `error` set when the registry could not be read though the gateway is
   *  up (credential rejected) — an empty list then is not an empty registry. */
  mcpServers: { registered: string[]; error?: string };
  /** Model access — how model calls are paid for and routed (APEX-115). */
  models: ModelAccessState;
  /** Remote-claude credential presence for the signed-in operator (annual
   *  subscription ceremony, or a company API key). Detection only — the
   *  consent itself is manual by Anthropic design. */
  claudeSession: { connected: boolean; source: "subscription_token" | "company_api_key" | null; setAt: string | null };
}

export const setupStateApi = {
  get: (orgId?: string) =>
    api.get<SetupState>(`/setup/state${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`),
};
