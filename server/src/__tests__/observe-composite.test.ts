import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { AgentRun, FleetEntry, HealthSummary, RunDetail } from "@paperclipai/shared";
import { CompositeObserveStore } from "../observe/composite-store.js";
import { CloudTraceObserveStore } from "../observe/cloud-trace-store.js";
import { ApexUnavailableError, type ApexInvoker } from "../apex/invoke.js";
import type { ObserveStore } from "../observe/tools.js";
import type { TraceEnricher } from "../observe/apex-eval-client.js";
import type { EvalRecord } from "../observe/contract.js";

function stubStore(partial: Partial<ObserveStore>): ObserveStore {
  const empty: ObserveStore = {
    fleet: async () => [],
    runs: async () => [],
    runDetail: async () => null,
    evals: async () => [],
    regressions: async () => [],
    health: async () => ({
      window: "24h",
      total: 0,
      succeeded: 0,
      failed: 0,
      running: 0,
      other: 0,
      successRate: null,
      avgDurationMs: null,
      totalCostUsd: 0,
      evalPassRate: null,
    }),
  };
  return { ...empty, ...partial };
}

function fleetEntry(name: string, source: string): FleetEntry {
  return {
    entryKind: "agent",
    displayName: name,
    health: "ok",
    lastRunAt: null,
    runs24h: 1,
    successRate: 1,
    source,
  };
}

describe("CompositeObserveStore", () => {
  it("merges fleet across all planes", async () => {
    const c = new CompositeObserveStore([
      stubStore({ fleet: async () => [fleetEntry("coding-agent", "heartbeat")] }),
      stubStore({ fleet: async () => [fleetEntry("orchestrator-dev", "gcp")] }),
    ]);
    const fleet = await c.fleet({});
    expect(fleet.map((f) => f.source).sort()).toEqual(["gcp", "heartbeat"]);
  });

  it("sums health counts + recomputes rate; a zeroed plane contributes nothing", async () => {
    const coding = stubStore({
      health: async (): Promise<HealthSummary> => ({
        window: "24h",
        total: 10,
        succeeded: 8,
        failed: 2,
        running: 0,
        other: 0,
        successRate: 0.8,
        avgDurationMs: 1000,
        totalCostUsd: 1.5,
        evalPassRate: null,
      }),
    });
    const productZeroed = stubStore({});
    const h = await new CompositeObserveStore([coding, productZeroed]).health({ windowHours: 24 });
    expect(h.total).toBe(10);
    expect(h.succeeded).toBe(8);
    expect(h.successRate).toBeCloseTo(0.8);
    expect(h.avgDurationMs).toBe(1000);
    expect(h.totalCostUsd).toBe(1.5);
  });

  it("failure-isolates: one plane throwing doesn't take down the other", async () => {
    const c = new CompositeObserveStore([
      stubStore({
        fleet: async () => {
          throw new Error("plane down");
        },
      }),
      stubStore({ fleet: async () => [fleetEntry("survivor", "gcp")] }),
    ]);
    const fleet = await c.fleet({});
    expect(fleet).toHaveLength(1);
    expect(fleet[0].source).toBe("gcp");
  });

  function baseRun(): AgentRun {
    return {
      runId: "run-1",
      status: "succeeded",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      stopReason: null,
      usage: null,
    };
  }

  it("runDetail merges an enricher's spans/toolCalls/evals onto the base run", async () => {
    const owner = stubStore({
      runDetail: async (): Promise<RunDetail> => ({
        run: baseRun(),
        spans: [],
        toolCalls: [],
        evals: [],
      }),
    });
    const enricher: TraceEnricher = {
      getTrace: async () => ({
        spans: [{ kind: "tool.call", name: "read_file", startedAt: null, durationMs: 5, attributes: {} }],
        toolCalls: [
          { runId: "run-1", name: "read_file", server: "fs", viaGateway: true, success: true, durationMs: 5, startedAt: null },
        ],
        evals: [
          {
            runId: "run-1",
            scenario: "smoke",
            validator: "schema",
            verdict: "pass",
            score: 1,
            reason: null,
            occurredAt: null,
          },
        ],
      }),
    };

    const c = new CompositeObserveStore([owner], [enricher]);
    const detail = await c.runDetail({ runId: "run-1" });

    expect(detail).not.toBeNull();
    expect(detail?.run).toEqual(baseRun());
    expect(detail?.spans).toHaveLength(1);
    expect(detail?.spans[0].name).toBe("read_file");
    expect(detail?.toolCalls).toHaveLength(1);
    expect(detail?.evals).toHaveLength(1);
    expect(detail?.evals[0].verdict).toBe("pass");
  });

  it("evals lists verdicts from an enricher that is also an eval store", async () => {
    const enricher: TraceEnricher = {
      getTrace: async () => ({ spans: [], toolCalls: [], evals: [] }),
      evals: async (input) => [
        {
          runId: "run-1",
          evaluatorId: "builtin:RunCompleted",
          library: "builtin",
          name: "RunCompleted",
          version: "1",
          scope: "run",
          verdict: "pass",
          score: 1,
          reason: `scoped to ${input.companyId ?? "all"}`,
          occurredAt: new Date().toISOString(),
          companyId: input.companyId ?? null,
        } as unknown as EvalRecord,
      ],
    };
    const owner = stubStore({});
    const c = new CompositeObserveStore([owner], [enricher]);
    const rows = await c.evals({ companyId: "co-1", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("scoped to co-1");
  });

  it("runDetail is not broken by an enricher that throws — base run still returned", async () => {
    const owner = stubStore({
      runDetail: async (): Promise<RunDetail> => ({
        run: baseRun(),
        spans: [],
        toolCalls: [],
        evals: [],
      }),
    });
    const brokenEnricher: TraceEnricher = {
      getTrace: async () => {
        throw new Error("apex-eval unreachable");
      },
    };

    const c = new CompositeObserveStore([owner], [brokenEnricher]);
    const detail = await c.runDetail({ runId: "run-1" });

    expect(detail).not.toBeNull();
    expect(detail?.run).toEqual(baseRun());
    expect(detail?.spans).toEqual([]);
    expect(detail?.toolCalls).toEqual([]);
    expect(detail?.evals).toEqual([]);
  });
});

describe("CloudTraceObserveStore", () => {
  function dbWithProjects(projects: string[]): Db {
    const b: Record<string, unknown> = {
      from: () => b,
      where: () => b,
      limit: () => Promise.resolve([{ gcpProjects: projects }]),
    };
    return { select: () => b } as unknown as Db;
  }

  it("maps Cloud Run services to product FleetEntries scoped by company projects", async () => {
    const invoker: ApexInvoker = {
      invoke: async () =>
        ({
          status: "success",
          services: [
            { name: "orchestrator-dev", ready: true },
            { name: "mcp-core-dev", ready: false },
          ],
        }) as never,
    };
    const store = new CloudTraceObserveStore(dbWithProjects(["finpilot-dev"]), invoker);
    const fleet = await store.fleet({ companyId: "c1" });
    expect(fleet).toHaveLength(2);
    expect(fleet[0]).toMatchObject({
      agentKind: "product",
      displayName: "orchestrator-dev",
      health: "ok",
      source: "gcp",
      projectId: "finpilot-dev",
    });
    expect(fleet[1].health).toBe("down");
  });

  it("returns empty (graceful) when the apex CLI is unavailable", async () => {
    const invoker: ApexInvoker = {
      invoke: async () => {
        throw new ApexUnavailableError("no apex");
      },
    };
    const store = new CloudTraceObserveStore(dbWithProjects(["p"]), invoker);
    expect(await store.fleet({ companyId: "c1" })).toEqual([]);
  });

  it("returns empty when the company has no GCP projects (never calls apex)", async () => {
    const invoker: ApexInvoker = {
      invoke: async () => {
        throw new Error("should not be called");
      },
    };
    const store = new CloudTraceObserveStore(dbWithProjects([]), invoker);
    expect(await store.fleet({ companyId: "c1" })).toEqual([]);
  });

  it("serviceHealth resolves region from the fleet listing then maps get_service_health", async () => {
    const invoker: ApexInvoker = {
      invoke: async (_server, tool) => {
        if (tool === "list_agent_services") {
          return {
            status: "success",
            services: [{ name: "orchestrator-dev", region: "asia-south1", url: "https://x", ready: true }],
          } as never;
        }
        // get_service_health
        return {
          health: "ok",
          ready: true,
          url: "https://x",
          latest_ready_revision: "orchestrator-dev-00007",
          conditions: [{ type: "Ready", status: "True", message: null }],
        } as never;
      },
    };
    const store = new CloudTraceObserveStore(dbWithProjects(["finpilot-dev"]), invoker);
    const health = await store.serviceHealth("c1", "orchestrator-dev");
    expect(health).toMatchObject({
      service: "orchestrator-dev",
      health: "ok",
      ready: true,
      revision: "orchestrator-dev-00007",
    });
    expect(health?.conditions[0]).toEqual({ type: "Ready", status: "True", message: null });
  });

  it("serviceHealth returns null when the service isn't in any project (graceful)", async () => {
    const invoker: ApexInvoker = {
      invoke: async () => ({ status: "success", services: [] }) as never,
    };
    const store = new CloudTraceObserveStore(dbWithProjects(["p"]), invoker);
    expect(await store.serviceHealth("c1", "missing")).toBeNull();
  });

  it("serviceLogs maps entries and normalizes trace id keys; failure → empty", async () => {
    const invoker: ApexInvoker = {
      invoke: async (_server, tool) => {
        if (tool === "list_agent_services") {
          return {
            status: "success",
            services: [{ name: "svc", region: "asia-south1", ready: true }],
          } as never;
        }
        // read_service_logs
        return {
          status: "success",
          entries: [
            { timestamp: "2026-07-24T12:00:00Z", severity: "ERROR", message: "boom", trace_id: "t-1" },
            { timestamp: "2026-07-24T12:00:01Z", severity: "INFO", message: "ok" },
          ],
        } as never;
      },
    };
    const store = new CloudTraceObserveStore(dbWithProjects(["p"]), invoker);
    const logs = await store.serviceLogs("c1", "svc");
    expect(logs).toHaveLength(2);
    expect(logs[0]).toEqual({
      timestamp: "2026-07-24T12:00:00Z",
      severity: "ERROR",
      message: "boom",
      traceId: "t-1",
    });
    expect(logs[1].traceId).toBeNull();
  });

  it("serviceHealth degrades to null when apex is unavailable", async () => {
    const invoker: ApexInvoker = {
      invoke: async () => {
        throw new ApexUnavailableError("no apex");
      },
    };
    const store = new CloudTraceObserveStore(dbWithProjects(["p"]), invoker);
    expect(await store.serviceHealth("c1", "svc")).toBeNull();
    expect(await store.serviceLogs("c1", "svc")).toEqual([]);
  });
});
