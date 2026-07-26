/**
 * Observe consumer contract — SHARED between the server (which validates every
 * APEX/MCP result against these schemas via apex/invoke.ts) and the UI (which
 * imports these types). One source of truth for the observe output shapes, so the
 * MCP output contract and the UI input contract cannot drift.
 *
 * The emitter-side attribute conventions (the correlation spine keys, span kinds,
 * metric names) live in the server's observe/contract.ts — they're what emitters
 * write, not what consumers read, and the UI doesn't need them.
 */
import { z } from "zod";

export const AgentKindSchema = z.enum(["coding", "product", "workflow"]);
export type AgentKind = z.infer<typeof AgentKindSchema>;
export const EnvSchema = z.enum(["dev", "staging", "prod", "local"]);
export type Env = z.infer<typeof EnvSchema>;
export const EvalVerdictSchema = z.enum(["pass", "warn", "fail"]);
export type EvalVerdict = z.infer<typeof EvalVerdictSchema>;

export const ScopeSchema = z.object({
  orgId: z.string().optional(),
  companyId: z.string().optional(),
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  agentKind: AgentKindSchema.optional(),
  repo: z.string().optional(),
  issueId: z.string().optional(),
  runId: z.string().optional(),
  env: EnvSchema.optional(),
});
export type ObserveScope = z.infer<typeof ScopeSchema>;

export const RunUsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  cachedInputTokens: z.number().nullable(),
  costUsd: z.number().nullable(),
  model: z.string().nullable(),
});
export type RunUsage = z.infer<typeof RunUsageSchema>;

export const AgentRunSchema = ScopeSchema.extend({
  runId: z.string(),
  status: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  stopReason: z.string().nullable(),
  usage: RunUsageSchema.nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const ToolCallSchema = z.object({
  runId: z.string(),
  name: z.string(),
  server: z.string().nullable(),
  viaGateway: z.boolean(),
  success: z.boolean(),
  durationMs: z.number().nullable(),
  startedAt: z.string().nullable(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const EvalRecordSchema = ScopeSchema.omit({ runId: true }).extend({
  runId: z.string().nullable(),
  scenario: z.string().nullable(),
  validator: z.string().nullable(),
  verdict: EvalVerdictSchema.nullable(),
  score: z.number().nullable(),
  reason: z.string().nullable(),
  occurredAt: z.string().nullable(),
});
export type EvalRecord = z.infer<typeof EvalRecordSchema>;

export const TraceSpanSchema = z.object({
  kind: z.string(),
  name: z.string(),
  startedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  attributes: z.record(z.string(), z.unknown()),
});
export type TraceSpan = z.infer<typeof TraceSpanSchema>;

export const RunDetailSchema = z.object({
  run: AgentRunSchema,
  spans: z.array(TraceSpanSchema),
  toolCalls: z.array(ToolCallSchema),
  evals: z.array(EvalRecordSchema),
});
export type RunDetail = z.infer<typeof RunDetailSchema>;

export const HealthSummarySchema = ScopeSchema.extend({
  window: z.string(),
  total: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  running: z.number(),
  other: z.number(),
  successRate: z.number().nullable(),
  avgDurationMs: z.number().nullable(),
  totalCostUsd: z.number(),
  evalPassRate: z.number().nullable(),
});
export type HealthSummary = z.infer<typeof HealthSummarySchema>;

export const FleetHealthSchema = z.enum(["ok", "degraded", "down", "dark", "unknown"]);
export type FleetHealth = z.infer<typeof FleetHealthSchema>;

export const FleetEntrySchema = ScopeSchema.extend({
  entryKind: z.enum(["agent", "mcp_server", "workflow"]),
  displayName: z.string(),
  health: FleetHealthSchema,
  lastRunAt: z.string().nullable(),
  runs24h: z.number(),
  successRate: z.number().nullable(),
  source: z.string(),
});
export type FleetEntry = z.infer<typeof FleetEntrySchema>;

// ── Product-agent GCP resource plane (Cloud Run) ─────────────────────────────
// A deployed product agent IS a Cloud Run service. These shapes carry the live
// GCP resource health + logs for one service, mapped from the APEX observability
// resource server (get-service-health / read-service-logs). Distinct from the
// run/trace shapes above (those are app-level agent executions).

export const ServiceHealthConditionSchema = z.object({
  type: z.string().nullable(),
  status: z.string().nullable(),
  message: z.string().nullable(),
});
export type ServiceHealthCondition = z.infer<typeof ServiceHealthConditionSchema>;

export const GcpServiceHealthSchema = z.object({
  service: z.string(),
  health: z.string(),
  ready: z.boolean(),
  url: z.string().nullable(),
  revision: z.string().nullable(),
  conditions: z.array(ServiceHealthConditionSchema),
});
export type GcpServiceHealth = z.infer<typeof GcpServiceHealthSchema>;

export const ServiceLogEntrySchema = z.object({
  timestamp: z.string().nullable(),
  severity: z.string().nullable(),
  message: z.string().nullable(),
  traceId: z.string().nullable().optional(),
});
export type ServiceLogEntry = z.infer<typeof ServiceLogEntrySchema>;

// The app-run correlation slice of GET /observe/gcp-resource — a product
// agent's runs as emitted to apex-eval, keyed by agentName == service name.
// Deliberately a narrower shape than AgentRun (no scope/usage fields): the
// apex-eval /runs listing only carries these fields today.
export const GcpResourceRunSchema = z.object({
  runId: z.string(),
  agentName: z.string().nullable(),
  status: z.string().nullable(),
  startedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type GcpResourceRun = z.infer<typeof GcpResourceRunSchema>;

// GET /observe/gcp-resource?companyId=&service= response — the unified
// product-agent pane: live GCP resource health, recent logs, and correlated
// app runs. Every slice is independently nullable/empty (failure-isolated on
// the server, never a 500), so the UI must render loading/empty per-slice.
export const GcpResourceResponseSchema = z.object({
  health: GcpServiceHealthSchema.nullable(),
  logs: z.array(ServiceLogEntrySchema),
  runs: z.array(GcpResourceRunSchema),
});
export type GcpResourceResponse = z.infer<typeof GcpResourceResponseSchema>;

// ── GCP resource inventory plane (all resource types, not just Cloud Run) ────
// Backed by APEX's `gcp_inventory` resource server (Cloud Asset Inventory +
// per-service gcloud queries). Distinct from the fleet/health planes above:
// this is raw project-scoped inventory, not agent-run observability, and every
// field is kept permissive (nullable/optional) because gcloud's output shape
// varies across resource/asset types.

export const InventoryResourceSchema = z.object({
  name: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  createTime: z.string().nullable().optional(),
  updateTime: z.string().nullable().optional(),
});
export type InventoryResource = z.infer<typeof InventoryResourceSchema>;

export const ProjectInventorySchema = z.object({
  projectId: z.string(),
  totalResources: z.number().nullable(),
  resourceTypes: z.number().nullable(),
  resourcesByType: z.record(z.string(), z.array(InventoryResourceSchema)),
  error: z.string().nullable().optional(),
});
export type ProjectInventory = z.infer<typeof ProjectInventorySchema>;

export const ProjectServicesSchema = z.object({
  projectId: z.string(),
  cloudRun: z.array(z.record(z.string(), z.unknown())).optional(),
  enabledApis: z.array(z.string()).optional(),
  secrets: z.array(z.record(z.string(), z.unknown())).optional(),
  buckets: z.array(z.record(z.string(), z.unknown())).optional(),
  error: z.string().nullable().optional(),
});
export type ProjectServices = z.infer<typeof ProjectServicesSchema>;

export const ResourceHealthSchema = z.object({
  projectId: z.string(),
  resourceType: z.string().nullable(),
  resourceName: z.string().nullable(),
  status: z.string().nullable(),
  ready: z.boolean().nullable().optional(),
  url: z.string().nullable().optional(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
});
export type ResourceHealth = z.infer<typeof ResourceHealthSchema>;

export const RegressionSchema = ScopeSchema.extend({
  metric: z.enum(["success_rate", "eval_score", "latency", "cost"]),
  displayName: z.string(),
  current: z.number(),
  previous: z.number(),
  deltaPct: z.number(),
  window: z.string(),
});
export type Regression = z.infer<typeof RegressionSchema>;
