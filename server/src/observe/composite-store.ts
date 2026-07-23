/**
 * CompositeObserveStore — merges multiple ObserveStores into one, so Observe shows
 * every plane at once: the coding-agent plane (HeartbeatObserveStore) and the
 * product-agent plane (CloudTraceObserveStore), and any future source, behind the
 * same interface.
 *
 * Each delegate call is failure-isolated: if one plane throws (e.g. apex CLI
 * missing, GCP unreachable) the others still return, so a degraded product plane
 * never takes down the coding plane.
 */
import type { z } from "zod";
import type { ObserveStore } from "./tools.js";
import type { observeInputs } from "./tools.js";
import type {
  AgentRun,
  EvalRecord,
  FleetEntry,
  HealthSummary,
  RunDetail,
  Regression,
} from "./contract.js";

async function settle<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

function startedMs(r: { startedAt: string | null }): number {
  return r.startedAt ? new Date(r.startedAt).getTime() : 0;
}

export class CompositeObserveStore implements ObserveStore {
  constructor(private readonly stores: ObserveStore[]) {}

  async fleet(input: z.infer<typeof observeInputs.fleet>): Promise<FleetEntry[]> {
    const parts = await Promise.all(this.stores.map((s) => settle(s.fleet(input), [] as FleetEntry[])));
    return parts.flat();
  }

  async runs(input: z.infer<typeof observeInputs.runs>): Promise<AgentRun[]> {
    const parts = await Promise.all(this.stores.map((s) => settle(s.runs(input), [] as AgentRun[])));
    return parts
      .flat()
      .sort((a, b) => startedMs(b) - startedMs(a))
      .slice(0, input.limit);
  }

  async runDetail(input: z.infer<typeof observeInputs.runDetail>): Promise<RunDetail | null> {
    for (const s of this.stores) {
      const d = await settle(s.runDetail(input), null);
      if (d) return d;
    }
    return null;
  }

  async evals(input: z.infer<typeof observeInputs.evals>): Promise<EvalRecord[]> {
    const parts = await Promise.all(this.stores.map((s) => settle(s.evals(input), [] as EvalRecord[])));
    return parts.flat().slice(0, input.limit);
  }

  async regressions(input: z.infer<typeof observeInputs.regressions>): Promise<Regression[]> {
    const parts = await Promise.all(
      this.stores.map((s) => settle(s.regressions(input), [] as Regression[])),
    );
    return parts.flat();
  }

  async health(input: z.infer<typeof observeInputs.health>): Promise<HealthSummary> {
    const summaries = (
      await Promise.all(this.stores.map((s) => settle(s.health(input), null)))
    ).filter((x): x is HealthSummary => x !== null);

    let total = 0,
      succeeded = 0,
      failed = 0,
      running = 0,
      other = 0,
      cost = 0,
      durWeighted = 0,
      durWeight = 0;
    for (const s of summaries) {
      total += s.total;
      succeeded += s.succeeded;
      failed += s.failed;
      running += s.running;
      other += s.other;
      cost += s.totalCostUsd;
      if (s.avgDurationMs != null) {
        durWeighted += s.avgDurationMs * s.total;
        durWeight += s.total;
      }
    }
    const settled = succeeded + failed;
    return {
      companyId: input.companyId,
      window: `${input.windowHours}h`,
      total,
      succeeded,
      failed,
      running,
      other,
      successRate: settled > 0 ? succeeded / settled : null,
      avgDurationMs: durWeight > 0 ? Math.round(durWeighted / durWeight) : null,
      totalCostUsd: Number(cost.toFixed(4)),
      // evalPassRate isn't mergeable without underlying counts; recompute when the
      // eval store lands. Prefer a single non-null if only one plane reports it.
      evalPassRate: summaries.find((s) => s.evalPassRate != null)?.evalPassRate ?? null,
    };
  }
}
