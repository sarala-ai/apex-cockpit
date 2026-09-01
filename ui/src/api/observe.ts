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
  GcpResourceResponse,
  ProjectInventory,
  ProjectServices,
  ResourceHealth,
  GatewayMetrics,
  AttributionConflict,
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

export interface GcpResourceQuery {
  companyId?: string;
  service: string;
}

function qs<T extends object>(scope: T = {} as T): string {
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
  gcpResource: (scope: GcpResourceQuery) =>
    api.get<GcpResourceResponse>(`/observe/gcp-resource${qs(scope)}`),
  gcpInventory: (scope?: { companyId?: string }) =>
    api.get<ProjectInventory[]>(`/observe/gcp-inventory${qs(scope)}`),
  gcpServices: (scope?: { companyId?: string }) =>
    api.get<ProjectServices[]>(`/observe/gcp-services${qs(scope)}`),
  gcpResourceHealth: (query: {
    companyId?: string;
    projectId: string;
    resourceType: string;
    resourceName: string;
    /** Cloud Asset Inventory's fully-qualified resource name, when known —
     *  stamped as the apex.resource.id cross-pane join key. */
    resourceId?: string;
  }) => api.get<ResourceHealth | null>(`/observe/gcp-resource-health${qs(query)}`),
  gatewayMetrics: () => api.get<GatewayMetrics>("/observe/gateway-metrics"),
  attributionConflicts: (scope: { companyId: string }) =>
    api.get<AttributionConflict[]>(`/observe/attribution/conflicts${qs(scope)}`),
  attributionManual: (body: {
    companyId: string;
    projectId: string;
    resourceUri: string;
    assetType: string;
    workflow?: string | null;
    repo?: string | null;
    env?: string | null;
  }) => api.post(`/observe/attribution/manual`, body),
};
