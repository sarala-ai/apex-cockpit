// Workflows read surface (cockpit Workflows migration, Part 2). Talks to the
// Express `/api/apex/workflows*` routes (server/src/routes/apex-workflows.ts),
// which shell apex-core's `apex workflows list`/`show` CLI. Both endpoints
// always 200 — a degraded/unreleased CLI comes back as a classified
// `WorkflowError` body ({status:"error",error_type,message,remediation}),
// never an HTTP error, so callers branch on `data.status` rather than
// `isError`.

import { api } from "./client";
import type { WorkflowDetailResponse, WorkflowListResponse } from "@paperclipai/shared";

// `companyId` (amendment: per-company env vars) scopes company-layer path
// entries to that company on the server; omitted degrades to today's
// behavior exactly (machine-global view, no company layers).
function companyQuery(companyId?: string | null): string {
  return companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
}

export const workflowsApi = {
  list: (companyId?: string | null) => api.get<WorkflowListResponse>(`/apex/workflows${companyQuery(companyId)}`),
  show: (name: string, companyId?: string | null) =>
    api.get<WorkflowDetailResponse>(`/apex/workflows/${encodeURIComponent(name)}${companyQuery(companyId)}`),
};
