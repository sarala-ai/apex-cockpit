// Observe API client — the control tower's data source.
//
// Talks to the /observe/* routes (server/src/routes/apex-observe.ts), which are
// thin passthroughs to the ObserveStore. Types are imported from
// @paperclipai/shared — the SAME schema the server validates its output against —
// so the UI cannot drift from the MCP/HTTP output contract.

import { api } from "./client";
import type {
  FleetEntry,
  AgentRun,
  HealthSummary,
  RunDetail,
  EvalRecord,
  Regression,
} from "@paperclipai/shared";

export interface ObserveScopeQuery {
  companyId?: string;
  projectId?: string;
  agentId?: string;
  repo?: string;
  env?: "dev" | "staging" | "prod" | "local";
  status?: string;
  verdict?: "pass" | "warn" | "fail";
  limit?: number;
  windowHours?: number;
}

function qs(scope: ObserveScopeQuery = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(scope)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export const observeApi = {
  fleet: (scope?: ObserveScopeQuery) => api.get<FleetEntry[]>(`/observe/fleet${qs(scope)}`),
  runs: (scope?: ObserveScopeQuery) => api.get<AgentRun[]>(`/observe/runs${qs(scope)}`),
  health: (scope?: ObserveScopeQuery) => api.get<HealthSummary | null>(`/observe/health${qs(scope)}`),
  runDetail: (runId: string) => api.get<RunDetail>(`/observe/run-detail/${encodeURIComponent(runId)}`),
  evals: (scope?: ObserveScopeQuery) => api.get<EvalRecord[]>(`/observe/evals${qs(scope)}`),
  regressions: (scope?: ObserveScopeQuery) =>
    api.get<Regression[]>(`/observe/regressions${qs(scope)}`),
};
