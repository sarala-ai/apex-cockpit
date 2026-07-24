/**
 * Agent-observability semantic contract — EMITTER SIDE.
 *
 * DURABLE CONTRACT — not a transient spec. The correlation spine, span kinds, and
 * metric names every emitter (product agents, the gateway, coding agents / Claude
 * Code, APEX workflows) writes, in its own language. Backend-agnostic: the same
 * attributes land in Cloud Trace / Cloud Monitoring, SigNoz, any OTLP sink.
 *
 * The CONSUMER shapes (what the observe layer returns and the UI reads) are the
 * schema-first definitions in `@paperclipai/shared` (observe.ts) — ONE source of
 * truth shared with the UI — re-exported here for server-side convenience. The
 * central reader (apex/invoke.ts) validates every APEX result against those
 * schemas, so MCP output and UI input cannot drift.
 *
 * Ideas:
 *  - SPINE: org → company → project → agent → run, + repo/issue/workflow/resource/
 *    env. The JOIN KEYS. Emit on the root span, propagate to children.
 *  - SPAN KINDS: agent.run (root), llm.call (reusing OTel gen_ai.*), tool.call,
 *    workflow.step, eval.
 *  - METRICS: run counts by status, durations, token/cost usage, eval scores.
 */

// ── The correlation spine (attribute keys carried by every signal) ───────────
export const Spine = {
  orgId: "apex.org.id",
  companyId: "apex.company.id",
  projectId: "apex.project.id",
  agentId: "apex.agent.id",
  agentName: "apex.agent.name",
  agentKind: "apex.agent.kind", // AgentKind
  runId: "apex.run.id", // correlates every span of one execution
  issueId: "apex.issue.id",
  repo: "apex.repo", // "owner/name"
  workflowName: "apex.workflow.name",
  workflowInstance: "apex.workflow.instance",
  resourceId: "apex.resource.id", // deployed GCP resource this run touches
  env: "apex.env", // Env
  // USER PLANE (browser-owned): the session a human is in. Set by FRONTENDS on
  // their spans + propagated to the backend via W3C traceparent so a user action
  // correlates to the run it triggers. OTel-standard `session.id` key (not apex.*).
  // Carries STRUCTURE only (session id, interaction type, timings) — never payload/PII.
  sessionId: "session.id",
} as const;

// ── Span kinds + their attribute vocabularies ────────────────────────────────
export const SpanKind = {
  agentRun: "agent.run", // root span of an execution
  llmCall: "llm.call", // an LLM invocation (gen_ai.* attrs below)
  toolCall: "tool.call", // a tool invocation (ideally via the gateway)
  workflowStep: "workflow.step",
  eval: "eval", // an evaluation verdict
} as const;

/**
 * The attribute key that carries the domain SpanKind above (values from SpanKind).
 * OTel's native span kind (CLIENT/SERVER/INTERNAL) is orthogonal — this is OUR
 * category. Emitters set this on each span; the apex-eval OTLP receiver reads it to
 * classify spans and derive tool_calls. Canonical here so emitter + receiver can't drift.
 */
export const SpanKindAttr = "apex.span.kind";

/** agent.run root-span attributes (beyond the spine). */
export const RunAttr = {
  status: "apex.run.status", // queued|running|succeeded|failed|cancelled
  model: "apex.run.model",
  stopReason: "apex.run.stop_reason",
  invocationSource: "apex.run.invocation_source",
} as const;

/**
 * LLM call — reuse OTel GenAI semantic conventions. Claude Code emits the metric
 * variants (claude_code.token.usage / .cost.usage, see Metric) which map onto
 * these; product agents SHOULD emit these span attributes on each model call.
 */
export const LlmAttr = {
  system: "gen_ai.system", // "anthropic" | "google" | ...
  model: "gen_ai.request.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cachedInputTokens: "gen_ai.usage.cached_input_tokens",
  costUsd: "apex.llm.cost_usd", // cost isn't in the GenAI spec — ours
} as const;

/** tool.call attributes. */
export const ToolAttr = {
  name: "apex.tool.name",
  server: "apex.tool.server", // MCP server / gateway upstream
  viaGateway: "apex.tool.via_gateway",
  success: "apex.tool.success",
} as const;

/** eval attributes. */
export const EvalAttr = {
  scenario: "apex.eval.scenario",
  validator: "apex.eval.validator",
  verdict: "apex.eval.verdict", // EvalVerdict
  score: "apex.eval.score", // 0..100
  reason: "apex.eval.reason",
} as const;

/** Metric names (health + trends). */
export const Metric = {
  runDuration: "apex.run.duration", // histogram, ms
  runCount: "apex.run.count", // counter, by status
  tokenUsage: "claude_code.token.usage", // Claude Code native; agents SHOULD mirror
  costUsage: "claude_code.cost.usage",
  evalScore: "apex.eval.score",
} as const;

// ── Consumer contract — shared source of truth (validated + typed in one place) ─
export {
  AgentKindSchema,
  EnvSchema,
  EvalVerdictSchema,
  ScopeSchema,
  RunUsageSchema,
  AgentRunSchema,
  ToolCallSchema,
  EvalRecordSchema,
  TraceSpanSchema,
  RunDetailSchema,
  HealthSummarySchema,
  FleetHealthSchema,
  FleetEntrySchema,
  RegressionSchema,
  GcpServiceHealthSchema,
  ServiceHealthConditionSchema,
  ServiceLogEntrySchema,
} from "@paperclipai/shared";
export type {
  AgentKind,
  Env,
  EvalVerdict,
  ObserveScope,
  RunUsage,
  AgentRun,
  ToolCall,
  EvalRecord,
  TraceSpan,
  RunDetail,
  HealthSummary,
  FleetHealth,
  FleetEntry,
  Regression,
  GcpServiceHealth,
  ServiceHealthCondition,
  ServiceLogEntry,
} from "@paperclipai/shared";
