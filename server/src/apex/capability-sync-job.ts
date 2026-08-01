/**
 * Recurring `apex capabilities sync` job (spec: capability sync +
 * PATH-canonical resolution, Session B / T4).
 *
 * Company-agnostic by design: a single scheduled tick syncs every source
 * configured in `~/.apex/settings.yaml` (`capability_sources`) regardless of
 * which company is active in the cockpit UI at the time — company scoping
 * only matters for WHICH PATH ENTRIES RESOLVE at workflow/skill lookup time
 * (see `workflows-cli.ts`'s `companySlug`), not for what this job syncs.
 *
 * Keeps the server thin per the spec: no new core CLI surface
 * (`apex capabilities status` does not exist), so the Workflows page's
 * banner reads the LAST summary this job produced, held in memory here —
 * not re-derived from lock files on every page load. `getLastCapabilitySync`
 * is a pure in-memory read (no CLI shell); `runCapabilitySync` is the only
 * thing that shells the CLI, used both by the scheduler and by the manual
 * `POST /apex/capabilities/sync` route for an on-demand refresh.
 */
import type { CapabilitySyncResponse } from "@paperclipai/shared";
import { CapabilitySyncCliClient } from "./capability-sync-cli.js";
import { periodicJobIntervalMs, startPeriodicJob } from "../lib/periodic-job.js";

const LOG_PREFIX = "[capability-sync]";

export type CapabilitySyncSnapshot = {
  ranAt: string;
  summary: CapabilitySyncResponse;
};

// Module-level: intentionally the ONE place the last run's result lives.
// Process-local (not persisted) — a restart clears it, same as any other
// "kept in memory" status the sibling schedulers don't persist either.
let lastSnapshot: CapabilitySyncSnapshot | null = null;

/** Read-only: the last summary this job (or a manual refresh) produced,
 *  or null before the first run since boot. Never shells the CLI. */
export function getLastCapabilitySync(): CapabilitySyncSnapshot | null {
  return lastSnapshot;
}

/** Test-only escape hatch to reset the module-level snapshot between cases. */
export function resetLastCapabilitySyncForTests(): void {
  lastSnapshot = null;
}

/**
 * Runs one `apex capabilities sync` pass and stores the result as the last
 * snapshot. Never throws — `CapabilitySyncCliClient` classifies every
 * failure mode (missing binary, unreleased command, the CLI's own error
 * envelope) into a `CapabilitySyncResponse`, so there is nothing left here
 * to catch.
 *
 * `cli_missing_command` is logged quietly (a single info line, not an error)
 * — until Session A's T1 CLI merges, every tick hits this path, and that is
 * an everyday/expected condition, not a job failure worth alarming on.
 */
export async function runCapabilitySync(
  opts: { client?: CapabilitySyncCliClient; log?: (line: string) => void } = {},
): Promise<CapabilitySyncResponse> {
  const client = opts.client ?? new CapabilitySyncCliClient();
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} ${line}`));

  const result = await client.sync();
  const summary: CapabilitySyncResponse = result.ok ? result.data : result.error;
  lastSnapshot = { ranAt: new Date().toISOString(), summary };

  if (!result.ok) {
    if (result.error.error_type === "cli_missing_command") {
      log(`sync skipped (CLI not ready yet): ${result.error.message}`);
    } else {
      log(`sync failed: ${result.error.error_type} — ${result.error.message}`);
    }
    return summary;
  }

  const divergedCount = result.data.diverged.length;
  const pendingCount = result.data.pending_skills.length;
  log(
    `sync ok: ${result.data.items.length} item(s) from [${result.data.sources.join(", ")}]` +
      (divergedCount > 0 ? `, ${divergedCount} diverged` : "") +
      (pendingCount > 0 ? `, ${pendingCount} pending skill(s)` : ""),
  );
  return summary;
}

/** Interval (ms) from `APEX_CAPABILITY_SYNC_HOURS` (default 12h, 0 disables). */
export function capabilitySyncIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return periodicJobIntervalMs("APEX_CAPABILITY_SYNC_HOURS", 12, env);
}

/** First-run delay after boot — same deliberate 5-minute offset as the
 *  attribution-refresh/github-ingest jobs (this shells a subprocess that
 *  clones/fetches sources, not on the fast startup-reconciliation path). */
export const CAPABILITY_SYNC_INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * Wires the recurring sync into server startup via the shared
 * `startPeriodicJob` helper (same shape as
 * `startAttributionRefreshScheduler`/`startGithubIssueIngestScheduler`).
 * Returns a disposer that clears both timers — call it on shutdown. A
 * 0-hour interval (`APEX_CAPABILITY_SYNC_HOURS=0`) disables scheduling
 * entirely; the manual `POST /apex/capabilities/sync` route still works
 * (it calls `runCapabilitySync` directly, not through the scheduler).
 */
export function startCapabilitySyncScheduler(
  opts: { intervalMs?: number; initialDelayMs?: number; log?: (line: string) => void } = {},
): () => void {
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} ${line}`));
  return startPeriodicJob({
    name: "capability-sync",
    envVar: "APEX_CAPABILITY_SYNC_HOURS",
    defaultHours: 12,
    initialDelayMs: opts.initialDelayMs ?? CAPABILITY_SYNC_INITIAL_DELAY_MS,
    intervalMs: opts.intervalMs,
    log,
    run: () => runCapabilitySync({ log }),
  });
}
