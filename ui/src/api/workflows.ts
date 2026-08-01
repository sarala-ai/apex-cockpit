// Workflows read surface (cockpit Workflows migration, Part 2). Talks to the
// Express `/api/apex/workflows*` routes (server/src/routes/apex-workflows.ts),
// which shell apex-core's `apex workflows list`/`show` CLI. Both endpoints
// always 200 — a degraded/unreleased CLI comes back as a classified
// `WorkflowError` body ({status:"error",error_type,message,remediation}),
// never an HTTP error, so callers branch on `data.status` rather than
// `isError`.

import { api } from "./client";
import type { WorkflowDetailResponse, WorkflowListResponse } from "@paperclipai/shared";

export const workflowsApi = {
  list: () => api.get<WorkflowListResponse>("/apex/workflows"),
  show: (name: string) => api.get<WorkflowDetailResponse>(`/apex/workflows/${encodeURIComponent(name)}`),
};
