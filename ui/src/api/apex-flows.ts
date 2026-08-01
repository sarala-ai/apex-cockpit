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

export const apexFlowsApi = {
  list: () => api.get<{ flows: FlowListRow[] }>("/apex/flows"),
  start: (issueId: string, flowName: string) =>
    api.post<StartFlowResponse>("/apex/flows/start", { issueId, flowName }),
};
