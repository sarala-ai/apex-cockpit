/**
 * Sandbox leases whose provider release failed (plugin worker down, RPC
 * timeout, cluster unreachable) are marked released in the database with
 * `cleanupStatus = failed`, but the provider resource — a Kubernetes Sandbox
 * CR with no owner and no TTL — is still running and still billing. This
 * sweep is the only thing that reads `cleanupStatus` back: it re-attempts
 * the release through the same driver path the run used, records each
 * attempt on the lease, and names every lease it could not reclaim so an
 * operator can delete the resource by hand.
 */
import { and, asc, inArray } from "drizzle-orm";
import { type Db, environmentLeases } from "@paperclipai/db";
import { startPeriodicJob } from "../lib/periodic-job.js";
import { environmentService } from "./environments.js";
import { environmentRuntimeService, type EnvironmentRuntimeService } from "./environment-runtime.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

/** Rows that left `active` but whose provider cleanup did not succeed. `retained`
 *  is excluded on purpose: retain_on_failure keeps the sandbox for inspection. */
const RETRYABLE_LEASE_STATUSES = ["released", "expired", "failed", "pending_cleanup"] as const;
const UNFINISHED_CLEANUP_STATUSES = ["failed", "pending"] as const;
const BATCH = 25;

export interface EnvironmentLeaseReaperDeps {
  runtime?: Pick<EnvironmentRuntimeService, "retryLeaseCleanup">;
  pluginWorkerManager?: PluginWorkerManager;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface EnvironmentLeaseCleanupRetryRecord {
  attempts: number;
  lastAttemptAt: string;
  lastOutcome: "success" | "failed";
  lastError: string | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readRetryRecord(metadata: Record<string, unknown> | null): EnvironmentLeaseCleanupRetryRecord | null {
  const candidate = metadata?.cleanupRetry;
  if (!candidate || typeof candidate !== "object") return null;
  const attempts = (candidate as Record<string, unknown>).attempts;
  return typeof attempts === "number" && Number.isFinite(attempts)
    ? (candidate as unknown as EnvironmentLeaseCleanupRetryRecord)
    : null;
}

export function environmentLeaseReaper(db: Db, deps: EnvironmentLeaseReaperDeps = {}) {
  const runtime =
    deps.runtime ?? environmentRuntimeService(db, { pluginWorkerManager: deps.pluginWorkerManager });
  const environmentsSvc = environmentService(db);
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.log(`[environment-lease-reaper] ${line}`));

  async function sweep(): Promise<{ reclaimed: number; stillPending: number }> {
    const rows = await db
      .select()
      .from(environmentLeases)
      .where(
        and(
          inArray(environmentLeases.status, [...RETRYABLE_LEASE_STATUSES]),
          inArray(environmentLeases.cleanupStatus, [...UNFINISHED_CLEANUP_STATUSES]),
        ),
      )
      .orderBy(asc(environmentLeases.updatedAt))
      .limit(BATCH);

    let reclaimed = 0;
    let stillPending = 0;
    for (const row of rows) {
      const attempts = (readRetryRecord(row.metadata)?.attempts ?? 0) + 1;
      let outcome: EnvironmentLeaseCleanupRetryRecord["lastOutcome"] = "failed";
      let lastError: string | null = null;
      try {
        const lease = await runtime.retryLeaseCleanup(row.id);
        if (!lease) {
          lastError = "no driver or environment can act on this lease";
        } else if (lease.cleanupStatus === "success") {
          outcome = "success";
        } else {
          lastError = "provider release did not succeed";
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      const retryRecord: EnvironmentLeaseCleanupRetryRecord = {
        attempts,
        lastAttemptAt: now().toISOString(),
        lastOutcome: outcome,
        lastError,
      };
      await environmentsSvc.updateLeaseMetadata(row.id, { ...(row.metadata ?? {}), cleanupRetry: retryRecord });

      if (outcome === "success") {
        reclaimed += 1;
        continue;
      }
      stillPending += 1;
      const identity = [
        `lease=${row.id}`,
        `status=${row.status}`,
        `provider=${row.provider ?? readString(row.metadata?.provider) ?? "unknown"}`,
        `providerLeaseId=${row.providerLeaseId ?? "none"}`,
        `namespace=${readString(row.metadata?.namespace) ?? "none"}`,
        `environment=${row.environmentId}`,
        `company=${row.companyId}`,
        `run=${row.heartbeatRunId ?? "none"}`,
      ].join(" ");
      log(`lease still not cleaned up after ${attempts} attempt(s): ${identity} — ${lastError}`);
    }
    if (reclaimed > 0) log(`reclaimed ${reclaimed} lease(s) (${stillPending} still pending)`);
    return { reclaimed, stillPending };
  }

  return { sweep };
}

const SWEEP_ENV_VAR = "APEX_SANDBOX_REAPER_SEC";

export function startEnvironmentLeaseReaper(
  db: Db,
  deps: EnvironmentLeaseReaperDeps & { intervalMs?: number } = {},
): () => void {
  const fromEnv = Number(process.env[SWEEP_ENV_VAR] ?? "300");
  const intervalMs = deps.intervalMs ?? (Number.isFinite(fromEnv) ? fromEnv * 1000 : 300_000);
  const job = environmentLeaseReaper(db, deps);
  return startPeriodicJob({
    name: "environment-lease-reaper",
    envVar: SWEEP_ENV_VAR,
    defaultHours: 0,
    intervalMs,
    initialDelayMs: Math.min(intervalMs, 30_000),
    run: () => job.sweep(),
  });
}
