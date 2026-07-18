// Onboarding-wizard detector client (apex-tower).
//
// Talks to the Express `GET /api/setup/state` route (server/src/routes/apex-setup-state.ts),
// a single failure-isolated snapshot of every setup prerequisite the wizard renders
// as a live checklist. `orgId` scopes the company count/list to that org.

import { api } from "./client";

type Health = "ok" | "missing" | "expired";

export interface SetupState {
  auth: { gcloud: Health; gh: Health; adc: Health };
  org: { present: boolean; id?: string };
  companies: { count: number; ids: string[] };
  scoping: { orgBound: boolean; companyBound: boolean };
  oauthClient: { configured: boolean; note?: string };
  gateway: { reachable: boolean };
  mcpServers: { registered: string[] };
}

export const setupStateApi = {
  get: (orgId?: string) =>
    api.get<SetupState>(`/setup/state${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ""}`),
};
