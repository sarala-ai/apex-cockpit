import { describe, expect, it } from "vitest";
import { buildRunTrace, classifyTool, parseRunLog } from "../observe/run-trace.js";

function logLine(ts: string, events: Array<Record<string, unknown>>) {
  return JSON.stringify({ ts, stream: "stdout", chunk: events.map((e) => JSON.stringify(e)).join("\n") + "\n" });
}

const LOG = [
  logLine("2026-09-03T04:19:40.000Z", [
    { type: "system", subtype: "init", model: "claude-sonnet-4-6", mcp_servers: [{ name: "apex-gateway" }] },
  ]),
  logLine("2026-09-03T04:19:44.000Z", [
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/opt/x" } }] },
    },
  ]),
  logLine("2026-09-03T04:19:45.000Z", [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
  ]),
  logLine("2026-09-03T04:20:00.000Z", [
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t2", name: "mcp__apex-gateway__github_create_pr", input: {} }] },
    },
  ]),
  logLine("2026-09-03T04:20:03.000Z", [
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", is_error: true, content: "403" }] } },
  ]),
  logLine("2026-09-03T04:20:10.000Z", [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: {} }] } },
  ]),
  "not json at all",
  logLine("2026-09-03T04:22:56.000Z", [
    { type: "result", subtype: "success", usage: { input_tokens: 19, output_tokens: 7443, cache_read_input_tokens: 603667 } },
  ]),
].join("\n");

describe("run trace", () => {
  it("classifies MCP tool names by server and flags the gateway", () => {
    expect(classifyTool("Read")).toEqual({ tool: "Read", server: "claude-code", viaGateway: false });
    expect(classifyTool("mcp__apex-gateway__github_create_pr")).toEqual({
      tool: "github_create_pr",
      server: "apex-gateway",
      viaGateway: true,
    });
    expect(classifyTool("mcp__penpot__list_files")).toEqual({ tool: "list_files", server: "penpot", viaGateway: false });
  });

  it("parses stream-json events out of run-log chunks and pairs tool uses with results", () => {
    const parsed = parseRunLog(LOG);
    expect(parsed.model).toBe("claude-sonnet-4-6");
    expect(parsed.mcpServers).toBe(1);
    expect(parsed.usage).toEqual({ inputTokens: 19, outputTokens: 7443, cacheReadTokens: 603667 });
    expect(parsed.toolUses.map((t) => [t.name, t.success])).toEqual([
      ["Read", true],
      ["mcp__apex-gateway__github_create_pr", false],
      ["Bash", null],
    ]);
  });

  it("builds one trace: an agent.run root and a tool.call child per tool use", () => {
    const trace = buildRunTrace({
      runId: "run-1",
      status: "succeeded",
      startedAt: new Date("2026-09-03T04:19:23Z"),
      finishedAt: new Date("2026-09-03T04:22:56Z"),
      logContent: LOG,
      spine: {
        orgId: "org-1",
        companyId: "co-1",
        projectId: "proj-1",
        agentId: "agent-1",
        agentName: "Implementer",
        agentKind: "coding",
        issueId: "issue-1",
        env: "prod",
      },
    });
    const spans = trace.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(4);
    expect(trace.toolCalls).toBe(3);
    const attrs = (i: number) => Object.fromEntries(spans[i]!.attributes.map((a) => [a.key, Object.values(a.value)[0]]));

    const root = attrs(0);
    expect(spans[0]!.parentSpanId).toBeUndefined();
    expect(root["apex.span.kind"]).toBe("agent.run");
    expect(root["apex.run.status"]).toBe("succeeded");
    expect(root["apex.run.id"]).toBe("run-1");
    expect(root["apex.issue.id"]).toBe("issue-1");
    expect(root["apex.org.id"]).toBe("org-1");
    expect(root["apex.model"]).toBe("claude-sonnet-4-6");
    expect(root["claude_code.token.usage.output"]).toBe("7443");
    expect(root["apex.tool.count"]).toBe("3");

    const gateway = attrs(2);
    expect(spans[2]!.parentSpanId).toBe(spans[0]!.spanId);
    expect(spans.every((s) => s.traceId === trace.traceId)).toBe(true);
    expect(gateway["apex.span.kind"]).toBe("tool.call");
    expect(gateway["apex.tool.name"]).toBe("github_create_pr");
    expect(gateway["apex.tool.server"]).toBe("apex-gateway");
    expect(gateway["apex.tool.via_gateway"]).toBe(true);
    expect(gateway["apex.tool.success"]).toBe(false);
    expect(spans[2]!.status).toEqual({ code: 2 });
    expect(BigInt(spans[2]!.endTimeUnixNano) - BigInt(spans[2]!.startTimeUnixNano)).toBe(3_000_000_000n);

    const unresolved = attrs(3);
    expect(unresolved["apex.tool.resolved"]).toBe(false);
    expect(spans[3]!.endTimeUnixNano).toBe(spans[0]!.endTimeUnixNano);
  });

  it("an empty or garbage log still yields the run's root span", () => {
    const trace = buildRunTrace({
      runId: "run-2",
      status: "failed",
      startedAt: null,
      finishedAt: new Date("2026-09-03T04:22:56Z"),
      logContent: "garbage\n{\"ts\":\"bad\"}\n",
      spine: { companyId: "co", agentId: "a", agentName: "X", agentKind: "product", env: "local" },
    });
    const spans = trace.body.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status).toEqual({ code: 2 });
    expect(trace.toolCalls).toBe(0);
  });
});
