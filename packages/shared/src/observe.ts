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

export const RegressionSchema = ScopeSchema.extend({
  metric: z.enum(["success_rate", "eval_score", "latency", "cost"]),
  displayName: z.string(),
  current: z.number(),
  previous: z.number(),
  deltaPct: z.number(),
  window: z.string(),
});
export type Regression = z.infer<typeof RegressionSchema>;
