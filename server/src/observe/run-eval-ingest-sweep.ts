/**
 * Feeds finished heartbeat runs into apex-eval as traces. A sweep, not a
 * hook: runs reach terminal status from a dozen code paths, and ingest must
 * survive apex-eval being down — a run is marked ingested only after apex-eval
 * accepted its trace, so anything missed is picked up next tick.
 */
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type Db, agents, agentWakeupRequests, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { startPeriodicJob } from "../lib/periodic-job.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { EvalIngestClient } from "./eval-ingest-client.js";
import { buildRunTrace, type RunTraceSpine } from "./run-trace.js";

const TERMINAL_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const BATCH = 25;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

export function runEnv(env: NodeJS.ProcessEnv = process.env): RunTraceSpine["env"] {
  const explicit = env.APEX_ENV;
  if (explicit === "dev" || explicit === "staging" || explicit === "prod" || explicit === "local") return explicit;
  return (env.PAPERCLIP_DEPLOYMENT_MODE ?? "local_trusted") === "local_trusted" ? "local" : "prod";
}

function agentKindFor(adapterType: string | null): RunTraceSpine["agentKind"] {
  return adapterType && /^(claude|codex|cursor|gemini|opencode)/.test(adapterType) ? "coding" : "product";
}

export interface RunEvalIngestDeps {
  ingest?: Pick<EvalIngestClient, "ingestRunTrace">;
  readLog?: (run: { logStore: string; logRef: string }) => Promise<string>;
  now?: () => Date;
  log?: (line: string) => void;
}

export function runEvalIngestSweep(db: Db, deps: RunEvalIngestDeps = {}) {
  const ingest = deps.ingest ?? new EvalIngestClient();
  const readLog =
    deps.readLog ??
    (async (run: { logStore: string; logRef: string }) =>
      (await getRunLogStore().read({ store: run.logStore as "local_file", logRef: run.logRef }, { limitBytes: MAX_LOG_BYTES }))
        .content);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(`[run-eval-ingest] ${line}`));

  async function sweep(): Promise<{ ingested: number; skipped: number; stoppedEarly: boolean }> {
    const rows = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        finishedAt: heartbeatRuns.finishedAt,
        logStore: heartbeatRuns.logStore,
        logRef: heartbeatRuns.logRef,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        agentName: agents.name,
        adapterType: agents.adapterType,
        orgId: companies.orgId,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
      .innerJoin(companies, eq(companies.id, heartbeatRuns.companyId))
      .where(and(
        inArray(heartbeatRuns.status, [...TERMINAL_STATUSES]),
        isNotNull(heartbeatRuns.finishedAt),
        isNull(heartbeatRuns.evalIngestedAt),
      ))
      .orderBy(asc(heartbeatRuns.finishedAt))
      .limit(BATCH);

    let ingested = 0;
    let skipped = 0;
    for (const row of rows) {
      const snapshotIssueId =
        row.contextSnapshot && typeof (row.contextSnapshot as Record<string, unknown>).issueId === "string"
          ? ((row.contextSnapshot as Record<string, unknown>).issueId as string)
          : null;
      const issue = await issueForRun(db, snapshotIssueId, row.wakeupRequestId);
      let logContent = "";
      if (row.logStore && row.logRef) {
        try {
          logContent = await readLog({ logStore: row.logStore, logRef: row.logRef });
        } catch (err) {
          log(`run ${row.id}: log unreadable (${(err as Error).message}); ingesting run without tool calls`);
        }
      }
      const trace = buildRunTrace({
        runId: row.id,
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        logContent,
        spine: {
          orgId: row.orgId,
          companyId: row.companyId,
          projectId: issue?.projectId ?? null,
          agentId: row.agentId,
          agentName: row.agentName,
          agentKind: agentKindFor(row.adapterType),
          issueId: issue?.id ?? null,
          env: runEnv(),
        },
      });
      const ok = await ingest.ingestRunTrace({ runId: row.id, body: trace.body });
      if (!ok) {
        log(`apex-eval did not accept run ${row.id}; stopping this tick (${ingested} ingested)`);
        return { ingested, skipped, stoppedEarly: true };
      }
      await db.update(heartbeatRuns).set({ evalIngestedAt: now() }).where(eq(heartbeatRuns.id, row.id));
      ingested += 1;
      if (trace.toolCalls === 0 && !logContent) skipped += 1;
    }
    if (ingested > 0) log(`ingested ${ingested} run(s) (${skipped} without a log)`);
    return { ingested, skipped, stoppedEarly: false };
  }

  return { sweep };
}

async function issueForRun(db: Db, snapshotIssueId: string | null, wakeupRequestId: string | null) {
  let issueId = snapshotIssueId;
  if (!issueId && wakeupRequestId) {
    const [wake] = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .limit(1);
    issueId = wake?.payload && typeof wake.payload.issueId === "string" ? wake.payload.issueId : null;
  }
  if (!issueId) return null;
  const [issue] = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return issue ?? null;
}

const SWEEP_ENV_VAR = "APEX_EVAL_RUN_INGEST_SEC";

export function startRunEvalIngestSweep(db: Db, deps: RunEvalIngestDeps & { intervalMs?: number } = {}): () => void {
  const fromEnv = Number(process.env[SWEEP_ENV_VAR] ?? "60");
  const intervalMs = deps.intervalMs ?? (Number.isFinite(fromEnv) ? fromEnv * 1000 : 60_000);
  const job = runEvalIngestSweep(db, deps);
  return startPeriodicJob({
    name: "run-eval-ingest",
    envVar: SWEEP_ENV_VAR,
    defaultHours: 0,
    intervalMs,
    initialDelayMs: Math.min(intervalMs, 30_000),
    run: () => job.sweep(),
  });
}
