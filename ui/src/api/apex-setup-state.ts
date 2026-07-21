// Onboarding-wizard detector client (apex-tower).
//
// Talks to the Express `GET /api/setup/state` route (server/src/routes/apex-setup-state.ts),
// a single failure-isolated snapshot of every setup prerequisite the wizard renders
// as a live checklist. `orgId` scopes the company count/list to that org.

import { api } from "./client";

type Health = "ok" | "missing" | "expired";

export interface SetupState {
  auth: { gcloud: Health; gh: Health; adc: Health };
  /** `posture` is the governance dial (default `individual`) — drives which
   *  hardening steps the wizard requires. */
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
  /** Org-level GitHub: App install + the single org WIF pool/provider (shallow
   *  config/env probe today; deep verification is a later APEX workflow). */
  orgGithub: { appInstalled: boolean; wifConfigured: boolean };
  oauthClient: { configured: boolean; note?: string };
  gateway: { reachable: boolean };
  mcpServers: { registered: string[] };
}

export const setupStateApi = {
  get: (orgId?: string) =>
    api.get<SetupState>(`/setup/state${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`),
};
