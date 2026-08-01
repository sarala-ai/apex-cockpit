import { api } from "./client";

/** A flow-definition summary row from `apex flows list` (via the server). */
export interface FlowListRow {
  name: string;
  path: string;
  version?: string;
  ticket_type?: string;
  description?: string;
  node_count?: number;
  gate_count?: number;
  error?: string;
  error_type?: string;
}

export interface StartFlowResponse {
  issueId: string;
  flowName: string;
  flowNodeId: string;
  flowStatus: string;
}

/** Statuses in which the operator recovery actions are offered. */
export const FLOW_RETRYABLE_STATUSES = ["paused", "failed"] as const;
export const FLOW_ABANDONABLE_STATUSES = ["paused", "failed", "waiting_gate"] as const;

export const apexFlowsApi = {
  list: () => api.get<{ flows: FlowListRow[] }>("/apex/flows"),
  start: (issueId: string, flowName: string) =>
    api.post<StartFlowResponse>("/apex/flows/start", { issueId, flowName }),
  /** Operator recovery: re-arm the current node (valid only from paused/failed). */
  retry: (issueId: string) =>
    api.post<StartFlowResponse>(`/issues/${issueId}/flow/retry`, {}),
  /** Operator recovery: terminal-fail the flow cleanly (paused/failed/waiting_gate). */
  abandon: (issueId: string) =>
    api.post<StartFlowResponse>(`/issues/${issueId}/flow/abandon`, {}),
};
