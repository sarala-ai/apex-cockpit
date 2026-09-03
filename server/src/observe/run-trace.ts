/**
 * A heartbeat run's log → one OTLP/JSON trace apex-eval already understands
 * (receiver.py decodes the spine + span-kind + tool attributes used here):
 * an `agent.run` root span for the run and one `tool.call` child per tool
 * use, with gateway-fronted MCP calls flagged so ToolSuccessRateEvaluator and
 * the tool_calls table see them as such. Token usage rides on the root.
 *
 * The log is the run-log store's NDJSON: one `{ts, stream, chunk}` per line,
 * where `chunk` holds Claude Code stream-json events (possibly several per
 * chunk). Anything unparseable is skipped, never fatal — a partial trace
 * beats no trace.
 */
import { randomBytes } from "node:crypto";

export interface RunTraceSpine {
  orgId?: string | null;
  companyId: string;
  projectId?: string | null;
  agentId: string;
  agentName: string;
  agentKind: "coding" | "product" | "workflow";
  repo?: string | null;
  issueId?: string | null;
  env: "dev" | "staging" | "prod" | "local";
}

export interface RunTraceInput {
  runId: string;
  status: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  spine: RunTraceSpine;
  logContent: string;
}

type OtlpValue = { stringValue: string } | { boolValue: boolean } | { intValue: string };
type OtlpAttr = { key: string; value: OtlpValue };

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status?: { code: number };
  attributes: OtlpAttr[];
}

export interface RunTrace {
  traceId: string;
  toolCalls: number;
  body: { resourceSpans: Array<{ resource: { attributes: OtlpAttr[] }; scopeSpans: Array<{ spans: OtlpSpan[] }> }> };
}

const str = (key: string, value: string): OtlpAttr => ({ key, value: { stringValue: value } });
const bool = (key: string, value: boolean): OtlpAttr => ({ key, value: { boolValue: value } });
const int = (key: string, value: number): OtlpAttr => ({ key, value: { intValue: String(Math.trunc(value)) } });

function nanos(date: Date): string {
  return String(BigInt(date.getTime()) * 1_000_000n);
}

function spineAttrs(spine: RunTraceSpine, runId: string): OtlpAttr[] {
  const attrs: OtlpAttr[] = [
    str("apex.company.id", spine.companyId),
    str("apex.agent.id", spine.agentId),
    str("apex.agent.name", spine.agentName),
    str("apex.agent.kind", spine.agentKind),
    str("apex.run.id", runId),
    str("apex.env", spine.env),
  ];
  if (spine.orgId) attrs.push(str("apex.org.id", spine.orgId));
  if (spine.projectId) attrs.push(str("apex.project.id", spine.projectId));
  if (spine.repo) attrs.push(str("apex.repo", spine.repo));
  if (spine.issueId) attrs.push(str("apex.issue.id", spine.issueId));
  return attrs;
}

/** MCP tool names are `mcp__<server>__<tool>`; everything else is a Claude Code built-in. */
export function classifyTool(name: string): { tool: string; server: string; viaGateway: boolean } {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name);
  if (!m) return { tool: name, server: "claude-code", viaGateway: false };
  const server = m[1]!;
  return { tool: m[2]!, server, viaGateway: server === "apex-gateway" };
}

interface ToolUse {
  id: string;
  name: string;
  startedAt: Date;
  endedAt: Date | null;
  success: boolean | null;
}

interface ParsedLog {
  model: string | null;
  mcpServers: number | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
  resultSubtype: string | null;
  toolUses: ToolUse[];
}

function* streamJsonEvents(logContent: string): Generator<{ ts: Date; event: Record<string, unknown> }> {
  for (const line of logContent.split("\n")) {
    if (!line.trim()) continue;
    let entry: { ts?: string; chunk?: string };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.chunk !== "string") continue;
    const ts = entry.ts ? new Date(entry.ts) : new Date(NaN);
    if (Number.isNaN(ts.getTime())) continue;
    for (const raw of entry.chunk.split("\n")) {
      if (!raw.trim().startsWith("{")) continue;
      try {
        yield { ts, event: JSON.parse(raw) };
      } catch {
        /* a chunk boundary can split an event; the remainder is not recoverable here */
      }
    }
  }
}

export function parseRunLog(logContent: string): ParsedLog {
  const parsed: ParsedLog = { model: null, mcpServers: null, usage: null, resultSubtype: null, toolUses: [] };
  const open = new Map<string, ToolUse>();
  for (const { ts, event } of streamJsonEvents(logContent)) {
    const type = event.type;
    if (type === "system" && event.subtype === "init") {
      if (typeof event.model === "string") parsed.model = event.model;
      if (Array.isArray(event.mcp_servers)) parsed.mcpServers = event.mcp_servers.length;
      continue;
    }
    const message = event.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
    if (type === "assistant") {
      for (const item of content) {
        if (item.type === "tool_use" && typeof item.id === "string" && typeof item.name === "string") {
          const use: ToolUse = { id: item.id, name: item.name, startedAt: ts, endedAt: null, success: null };
          open.set(use.id, use);
          parsed.toolUses.push(use);
        }
      }
      continue;
    }
    if (type === "user") {
      for (const item of content) {
        if (item.type === "tool_result" && typeof item.tool_use_id === "string") {
          const use = open.get(item.tool_use_id);
          if (!use) continue;
          use.endedAt = ts;
          use.success = item.is_error !== true;
          open.delete(use.id);
        }
      }
      continue;
    }
    if (type === "result") {
      if (typeof event.subtype === "string") parsed.resultSubtype = event.subtype;
      const usage = event.usage as Record<string, unknown> | undefined;
      if (usage) {
        parsed.usage = {
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
        };
      }
    }
  }
  return parsed;
}

export function buildRunTrace(input: RunTraceInput): RunTrace {
  const parsed = parseRunLog(input.logContent);
  const traceId = randomBytes(16).toString("hex");
  const rootSpanId = randomBytes(8).toString("hex");
  const startedAt = input.startedAt ?? input.finishedAt ?? new Date();
  const finishedAt = input.finishedAt ?? startedAt;
  const succeeded = input.status === "succeeded";
  const spine = spineAttrs(input.spine, input.runId);

  const rootAttrs: OtlpAttr[] = [
    str("apex.span.kind", "agent.run"),
    ...spine,
    str("apex.run.status", succeeded ? "succeeded" : "failed"),
    int("apex.tool.count", parsed.toolUses.length),
  ];
  if (parsed.model) rootAttrs.push(str("apex.model", parsed.model));
  if (parsed.mcpServers !== null) rootAttrs.push(int("apex.mcp.servers", parsed.mcpServers));
  if (parsed.resultSubtype) rootAttrs.push(str("apex.result.subtype", parsed.resultSubtype));
  if (parsed.usage) {
    rootAttrs.push(int("claude_code.token.usage.input", parsed.usage.inputTokens));
    rootAttrs.push(int("claude_code.token.usage.output", parsed.usage.outputTokens));
    rootAttrs.push(int("claude_code.token.usage.cache_read", parsed.usage.cacheReadTokens));
  }

  const spans: OtlpSpan[] = [
    {
      traceId,
      spanId: rootSpanId,
      name: `heartbeat-run:${input.spine.agentName}`,
      startTimeUnixNano: nanos(startedAt),
      endTimeUnixNano: nanos(finishedAt),
      status: { code: succeeded ? 1 : 2 },
      attributes: rootAttrs,
    },
  ];

  for (const use of parsed.toolUses) {
    const { tool, server, viaGateway } = classifyTool(use.name);
    const endedAt = use.endedAt ?? finishedAt;
    spans.push({
      traceId,
      spanId: randomBytes(8).toString("hex"),
      parentSpanId: rootSpanId,
      name: `tool:${tool}`,
      startTimeUnixNano: nanos(use.startedAt),
      endTimeUnixNano: nanos(endedAt),
      status: { code: use.success === false ? 2 : 1 },
      attributes: [
        str("apex.span.kind", "tool.call"),
        ...spine,
        str("apex.tool.name", tool),
        str("apex.tool.server", server),
        bool("apex.tool.via_gateway", viaGateway),
        bool("apex.tool.success", use.success === true),
        bool("apex.tool.resolved", use.success !== null),
      ],
    });
  }

  return {
    traceId,
    toolCalls: parsed.toolUses.length,
    body: { resourceSpans: [{ resource: { attributes: [] }, scopeSpans: [{ spans }] }] },
  };
}
