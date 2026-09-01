// Gateway API client — apex-gateway's governance surface (registry + audit
// ledger). Talks to /gateway/* (server/src/routes/apex-gateway-observe.ts).
// Metrics live under observeApi.gatewayMetrics instead — operational health,
// not governance, see @paperclipai/shared/gateway for the rationale.

import { api } from "./client";
import type {
  GatewayRegistry,
  GatewayAgentEntry,
  GatewayAuditEntry,
  GatewayRegisterInput,
} from "@paperclipai/shared";

export const gatewayApi = {
  registry: () => api.get<GatewayRegistry>("/gateway/registry"),
  agents: () => api.get<GatewayAgentEntry[]>("/gateway/agents"),
  audit: (limit = 100) => api.get<GatewayAuditEntry[]>(`/gateway/audit?limit=${limit}`),
  // Register a new upstream MCP server — the write path behind "Add MCP
  // server" in the Registry tab. Federates the server's tools on success, so
  // a registry refetch right after this resolves is expected to also surface
  // new tool entries, not just the new gateway.
  register: (input: GatewayRegisterInput) =>
    api.post<{ id: string | null; name: string }>("/gateway/registry", input),
  // OAuth (authorization_code) upstreams: consent must be a full-page
  // navigation — the server route 302s to the provider's consent page — so
  // authorizeUrl is a URL to navigate to, not a fetch.
  authorizeUrl: (gatewayId: string) => `/api/gateway/oauth/${gatewayId}/authorize`,
  fetchTools: (gatewayId: string) =>
    api.post<{ message: string }>(`/gateway/oauth/${gatewayId}/fetch-tools`, {}),
};
