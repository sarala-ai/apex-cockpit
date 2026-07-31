/**
 * Gateway consumer contract — apex-gateway's GOVERNANCE surface (registry of
 * what's registered/callable, and the audit ledger of what actually happened),
 * as distinct from Observe's operational-health surface. See observe.ts for
 * why gateway tool-call METRICS (throughput/latency/error-rate) live there
 * instead: metrics are operational health, not governance.
 *
 * Every schema here is an explicit, narrow field pick from apex-gateway's much
 * larger read models (GatewayRead/ToolRead/A2AAgentRead/ServerRead in
 * mcpgateway/schemas.py) — deliberately dropping auth_value/auth_headers/
 * oauth_config and any other secret-bearing fields, so a bug can't leak a
 * credential to the browser just by forwarding "everything the gateway sent."
 */
import { z } from "zod";

export const GatewayEntrySchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  url: z.string().nullable(),
  transport: z.string().nullable(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  reachable: z.boolean(),
  createdAt: z.string().nullable(),
});
export type GatewayEntry = z.infer<typeof GatewayEntrySchema>;

export const GatewayToolEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  integrationType: z.string().nullable(),
  enabled: z.boolean(),
});
export type GatewayToolEntry = z.infer<typeof GatewayToolEntrySchema>;

export const GatewayServerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  associatedToolCount: z.number(),
});
export type GatewayServerEntry = z.infer<typeof GatewayServerEntrySchema>;

export const GatewayRegistrySchema = z.object({
  gateways: z.array(GatewayEntrySchema),
  tools: z.array(GatewayToolEntrySchema),
  servers: z.array(GatewayServerEntrySchema),
  error: z.string().nullable(),
});
export type GatewayRegistry = z.infer<typeof GatewayRegistrySchema>;

// ── Registering a new upstream MCP server — the writable path added on top of
// the read-only registry above. `transport` is intentionally the small enum
// the cockpit UI supports (STDIO omitted from the form: it needs a `command`
// to spawn a subprocess, not a URL, and isn't meaningful from a browser).
export const GatewayRegisterInputSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  transport: z.enum(["SSE", "STREAMABLEHTTP", "STDIO"]),
  description: z.string().optional(),
});
export type GatewayRegisterInput = z.infer<typeof GatewayRegisterInputSchema>;

export const GatewayAgentEntrySchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  slug: z.string().nullable(),
  description: z.string().nullable(),
  endpointUrl: z.string(),
  agentType: z.string().nullable(),
  protocolVersion: z.string().nullable(),
  enabled: z.boolean(),
  reachable: z.boolean(),
});
export type GatewayAgentEntry = z.infer<typeof GatewayAgentEntrySchema>;

export const GatewayAuditEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  correlationId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  resourceName: z.string().nullable(),
  userId: z.string(),
  userEmail: z.string().nullable(),
  success: z.boolean(),
  requiresReview: z.boolean(),
});
export type GatewayAuditEntry = z.infer<typeof GatewayAuditEntrySchema>;

// ── Gateway tool-call metrics — lives under Observe's Metrics & Alerts, not
// the Gateway page (operational health, not governance). Kept here since it's
// still gateway-shaped data validated by the same gateway client.
export const GatewayEntityMetricsSchema = z.object({
  totalExecutions: z.number(),
  successfulExecutions: z.number(),
  failedExecutions: z.number(),
  failureRate: z.number().nullable(),
  avgResponseTime: z.number().nullable(),
});
export type GatewayEntityMetrics = z.infer<typeof GatewayEntityMetricsSchema>;

export const GatewayMetricsSchema = z.object({
  reachable: z.boolean(),
  tools: GatewayEntityMetricsSchema.nullable(),
  servers: GatewayEntityMetricsSchema.nullable(),
  a2aAgents: GatewayEntityMetricsSchema.nullable(),
  error: z.string().nullable(),
});
export type GatewayMetrics = z.infer<typeof GatewayMetricsSchema>;
