/**
 * HeartbeatObserveStore — the first ObserveStore implementation.
 *
 * Reads the cockpit's OWN control-plane runs (`heartbeat_runs`) — the coding-agent
 * plane — and maps them onto the semantic contract. This is the "real data now"
 * adapter: the data already exists and is company-scoped, so it gives the observe
 * surface (and the control tower) live content immediately, while the Cloud Trace
 * store (#6) adds the product-agent plane behind the SAME interface.
 *
 * Trace-level fields (spans, tool calls) and evals are empty here — heartbeat rows
 * are run records, not OTel traces. Those populate from the OTel-backed stores.
 * Dark agents (registered, zero runs) come from the registry, not this store.
 */
import { and, desc, eq, gte, type SQL } from "drizzle-orm";
import { type Db, heartbeatRuns, agents } from "@paperclipai/db";
import { z } from "zod";
import type { ObserveStore } from "./tools.js";
import { observeInputs } from "./tools.js";
import type {
  AgentRun,
  EvalRecord,
  FleetEntry,
  FleetHealth,
  HealthSummary,
  RunDetail,
  Regression,
} from "./contract.js";

const SUCCESS = new Set(["succeeded", "completed", "done", "passed", "success"]);
const FAILED = new Set(["failed", "error", "cancelled", "canceled"]);
const INFLIGHT = new Set(["running", "queued", "in_progress", "pending", "starting"]);

type Bucket = "succeeded" | "failed" | "running" | "other";
function classify(status: string): Bucket {
  const s = (status ?? "").toLowerCase();
  if (SUCCESS.has(s)) return "succeeded";
  if (FAILED.has(s)) return "failed";
  if (INFLIGHT.has(s)) return "running";
  return "other";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function iso(d: Date | null): string | null {
  return d ? new Date(d).toISOString() : null;
}
function durationMs(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

interface RunRow {
  id: string;
  status: string;
  agentId: string | null;
  companyId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown> | null;
  agentName: string | null;
}

function mapRun(r: RunRow): AgentRun {
  const usage = r.usageJson ?? null;
  const result = r.resultJson ?? {};
  const ctx = r.contextSnapshot ?? {};
  return {
    runId: r.id,
    status: r.status,
    agentId: r.agentId ?? undefined,
    agentName: r.agentName ?? undefined,
    agentKind: "coding",
    companyId: r.companyId ?? undefined,
    issueId: typeof ctx.issueId === "string" ? ctx.issueId : undefined,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationMs: durationMs(r.startedAt, r.finishedAt),
    stopReason: typeof result.stopReason === "string" ? result.stopReason : null,
    usage: usage
      ? {
          inputTokens: num(usage.inputTokens),
          outputTokens: num(usage.outputTokens),
          cachedInputTokens: num(usage.cachedInputTokens),
          costUsd: num(usage.costUsd),
          model: typeof usage.model === "string" ? usage.model : null,
        }
      : null,
  };
}

const RUN_COLUMNS = {
  id: heartbeatRuns.id,
  status: heartbeatRuns.status,
  agentId: heartbeatRuns.agentId,
  companyId: heartbeatRuns.companyId,
  startedAt: heartbeatRuns.startedAt,
  finishedAt: heartbeatRuns.finishedAt,
  usageJson: heartbeatRuns.usageJson,
  resultJson: heartbeatRuns.resultJson,
  contextSnapshot: heartbeatRuns.contextSnapshot,
  agentName: agents.name,
} as const;

export class HeartbeatObserveStore implements ObserveStore {
  constructor(private readonly db: Db) {}

  private companyFilter(companyId?: string): SQL | undefined {
    return companyId ? eq(heartbeatRuns.companyId, companyId) : undefined;
  }

  private since(hours: number): Date {
    return new Date(Date.now() - hours * 3600_000);
  }

  async runs(input: z.infer<typeof observeInputs.runs>): Promise<AgentRun[]> {
    const rows = (await this.db
      .select(RUN_COLUMNS)
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(this.companyFilter(input.companyId))
      .orderBy(desc(heartbeatRuns.createdAt))
      .limit(input.limit)) as RunRow[];
    const mapped = rows.map(mapRun);
    return input.status ? mapped.filter((r) => r.status === input.status) : mapped;
  }

  async runDetail(input: z.infer<typeof observeInputs.runDetail>): Promise<RunDetail | null> {
    const rows = (await this.db
      .select(RUN_COLUMNS)
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(eq(heartbeatRuns.id, input.runId))
      .limit(1)) as RunRow[];
    if (rows.length === 0) return null;
    // spans/toolCalls/evals come from the OTel-backed stores, not heartbeat rows.
    return { run: mapRun(rows[0]), spans: [], toolCalls: [], evals: [] };
  }

  async health(input: z.infer<typeof observeInputs.health>): Promise<HealthSummary> {
    const rows = (await this.db
      .select({
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        usageJson: heartbeatRuns.usageJson,
      })
      .from(heartbeatRuns)
      .where(
        and(this.companyFilter(input.companyId), gte(heartbeatRuns.createdAt, this.since(input.windowHours))),
      )) as Array<Pick<RunRow, "status" | "startedAt" | "finishedAt" | "usageJson">>;

    let succeeded = 0,
      failed = 0,
      running = 0,
      other = 0,
      durSum = 0,
      durN = 0,
      cost = 0;
    for (const r of rows) {
      const b = classify(r.status);
      if (b === "succeeded") succeeded++;
      else if (b === "failed") failed++;
      else if (b === "running") running++;
      else other++;
      const d = durationMs(r.startedAt, r.finishedAt);
      if (d != null) {
        durSum += d;
        durN++;
      }
      const c = num(r.usageJson?.costUsd);
      if (c != null) cost += c;
    }
    const settled = succeeded + failed;
    return {
      companyId: input.companyId,
      window: `${input.windowHours}h`,
      total: rows.length,
      succeeded,
      failed,
      running,
      other,
      successRate: settled > 0 ? succeeded / settled : null,
      avgDurationMs: durN > 0 ? Math.round(durSum / durN) : null,
      totalCostUsd: cost > 0 ? Number(cost.toFixed(4)) : 0,
      evalPassRate: null, // no evals in the heartbeat plane
    };
  }

  async fleet(input: z.infer<typeof observeInputs.fleet>): Promise<FleetEntry[]> {
    const rows = (await this.db
      .select(RUN_COLUMNS)
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(and(this.companyFilter(input.companyId), gte(heartbeatRuns.createdAt, this.since(24))))
      .orderBy(desc(heartbeatRuns.createdAt))) as RunRow[];

    const byAgent = new Map<
      string,
      { name: string | null; runs: number; succeeded: number; failed: number; running: number; lastRunAt: string | null }
    >();
    for (const r of rows) {
      const key = r.agentId ?? "unknown";
      const agg = byAgent.get(key) ?? { name: r.agentName, runs: 0, succeeded: 0, failed: 0, running: 0, lastRunAt: null };
      agg.runs++;
      const b = classify(r.status);
      if (b === "succeeded") agg.succeeded++;
      else if (b === "failed") agg.failed++;
      else if (b === "running") agg.running++;
      const started = iso(r.startedAt);
      if (started && (!agg.lastRunAt || started > agg.lastRunAt)) agg.lastRunAt = started;
      byAgent.set(key, agg);
    }

    return [...byAgent.entries()].map(([agentId, a]): FleetEntry => {
      const settled = a.succeeded + a.failed;
      const successRate = settled > 0 ? a.succeeded / settled : null;
      let health: FleetHealth;
      if (a.runs === 0) health = "dark";
      else if (a.running > 0 && settled === 0) health = "ok";
      else if (successRate == null) health = "unknown";
      else if (successRate >= 0.9) health = "ok";
      else if (successRate >= 0.5) health = "degraded";
      else health = "down";
      return {
        entryKind: "agent",
        agentId,
        agentName: a.name ?? undefined,
        agentKind: "coding",
        companyId: input.companyId,
        displayName: a.name ?? agentId,
        health,
        lastRunAt: a.lastRunAt,
        runs24h: a.runs,
        successRate,
        source: "heartbeat",
      };
    });
  }

  // Evals live in the OTel/eval stores, not the heartbeat plane.
  async evals(_input: z.infer<typeof observeInputs.evals>): Promise<EvalRecord[]> {
    return [];
  }

  async regressions(input: z.infer<typeof observeInputs.regressions>): Promise<Regression[]> {
    const w = input.windowHours;
    const rows = (await this.db
      .select({
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        createdAt: heartbeatRuns.createdAt,
        usageJson: heartbeatRuns.usageJson,
      })
      .from(heartbeatRuns)
      .where(and(this.companyFilter(input.companyId), gte(heartbeatRuns.createdAt, this.since(w * 2))))) as Array<{
      status: string;
      startedAt: Date | null;
      finishedAt: Date | null;
      createdAt: Date;
      usageJson: Record<string, unknown> | null;
    }>;

    const cutoff = this.since(w).getTime();
    const cur = { n: 0, ok: 0, dur: 0, durN: 0, cost: 0 };
    const prev = { n: 0, ok: 0, dur: 0, durN: 0, cost: 0 };
    for (const r of rows) {
      const bucket = new Date(r.createdAt).getTime() >= cutoff ? cur : prev;
      bucket.n++;
      if (classify(r.status) === "succeeded") bucket.ok++;
      const d = durationMs(r.startedAt, r.finishedAt);
      if (d != null) {
        bucket.dur += d;
        bucket.durN++;
      }
      const c = num(r.usageJson?.costUsd);
      if (c != null) bucket.cost += c;
    }
    if (cur.n === 0 || prev.n === 0) return []; // need both windows to compare

    const out: Regression[] = [];
    const window = `${w}h vs prior ${w}h`;
    const push = (metric: Regression["metric"], displayName: string, current: number, previous: number, worseWhenHigher: boolean) => {
      const worse = worseWhenHigher ? current > previous : current < previous;
      if (!worse || previous === 0) return;
      const deltaPct = Number((((current - previous) / previous) * 100).toFixed(1));
      out.push({ companyId: input.companyId, metric, displayName, current: Number(current.toFixed(3)), previous: Number(previous.toFixed(3)), deltaPct, window });
    };
    push("success_rate", "Success rate", cur.ok / cur.n, prev.ok / prev.n, false);
    if (cur.durN && prev.durN) push("latency", "Avg duration (ms)", cur.dur / cur.durN, prev.dur / prev.durN, true);
    push("cost", "Total cost (USD)", cur.cost, prev.cost, true);
    return out;
  }
}
