import { afterEach, describe, expect, it, vi } from "vitest";
import { ApexEvalTraceClient } from "../observe/apex-eval-client.js";

describe("ApexEvalTraceClient.getRuns", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and validates a product agent's app runs, keyed by company + agentName", async () => {
    const rows = [
      { runId: "run-b", agentName: "orchestrator-dev", status: "1", startedAt: "2026-07-24T13:00:00Z", durationMs: 2000 },
      { runId: "run-a", agentName: "orchestrator-dev", status: "2", startedAt: "2026-07-24T12:00:00Z", durationMs: null },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApexEvalTraceClient("http://eval.test");
    const runs = await client.getRuns("company-1", "orchestrator-dev");

    expect(runs).toHaveLength(2);
    expect(runs[0].runId).toBe("run-b");
    expect(runs[1].durationMs).toBeNull();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("companyId=company-1");
    expect(url).toContain("agentName=orchestrator-dev");
  });

  it("degrades to empty when apex-eval returns non-200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const client = new ApexEvalTraceClient("http://eval.test");
    expect(await client.getRuns("c1", "svc")).toEqual([]);
  });

  it("degrades to empty when fetch throws (apex-eval unreachable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    const client = new ApexEvalTraceClient("http://eval.test");
    expect(await client.getRuns("c1", "svc")).toEqual([]);
  });
});
