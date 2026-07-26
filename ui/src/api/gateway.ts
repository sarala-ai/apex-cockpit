// Gateway API client — apex-gateway's governance surface (registry + audit
// ledger). Talks to /gateway/* (server/src/routes/apex-gateway-observe.ts).
// Metrics live under observeApi.gatewayMetrics instead — operational health,
// not governance, see @paperclipai/shared/gateway for the rationale.

import { api } from "./client";
import type { GatewayRegistry, GatewayAgentEntry, GatewayAuditEntry } from "@paperclipai/shared";

export const gatewayApi = {
  registry: () => api.get<GatewayRegistry>("/gateway/registry"),
  agents: () => api.get<GatewayAgentEntry[]>("/gateway/agents"),
  audit: (limit = 100) => api.get<GatewayAuditEntry[]>(`/gateway/audit?limit=${limit}`),
};
