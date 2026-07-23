import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type { FleetEntry, HealthSummary } from "@paperclipai/shared";
import { CompositeObserveStore } from "../observe/composite-store.js";
import { CloudTraceObserveStore } from "../observe/cloud-trace-store.js";
import { ApexUnavailableError, type ApexInvoker } from "../apex/invoke.js";
import type { ObserveStore } from "../observe/tools.js";

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
});
