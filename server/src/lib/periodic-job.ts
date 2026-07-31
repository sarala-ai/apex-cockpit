/**
 * Finding 8 (adversarial architecture review): `startAttributionRefreshScheduler`
 * (observe/attribution-refresh.ts) and `startGithubIssueIngestScheduler`
 * (apex/pipeline/github-issue-ingest.ts) hand-rolled ~30 duplicated lines of
 * `setTimeout` + `setInterval` scheduling each. This extracts that shape
 * (env-configurable interval hours, 0 disables, deliberate initial delay,
 * disposer clears both timers, run failures are logged not thrown) into one
 * helper both now use.
 *
 * Deliberately NOT used by the pre-existing heartbeat scheduler or the
 * database-backup job in index.ts — those have their own bespoke shapes
 * (in-flight tracking, health-file side channels) predating this finding and
 * are out of scope for this extraction.
 */

/** Interval (ms) from an hours-valued env var. `undefined`/blank/garbage/negative
 *  falls back to `defaultHours`; `0` means "disabled" and is passed through as 0. */
export function periodicJobIntervalMs(
  envVar: string,
  defaultHours: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[envVar];
  if (raw === undefined || raw.trim() === "") return defaultHours * 60 * 60 * 1000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return defaultHours * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

export type PeriodicJobOptions = {
  /** Short name used in log lines, e.g. "github-issue-ingest". */
  name: string;
  /** Env var name controlling the interval, in hours (e.g. "APEX_GITHUB_INGEST_HOURS"). */
  envVar: string;
  /** Default interval in hours when the env var is unset/blank/garbage. */
  defaultHours: number;
  /** Delay before the first run after boot. */
  initialDelayMs: number;
  /** The job body. Rejections are caught and logged — never thrown into the timer. */
  run: () => Promise<unknown>;
  /** Override the resolved interval directly (tests / explicit callers). */
  intervalMs?: number;
  log?: (line: string) => void;
};

/**
 * Wires a recurring job into server startup: resolve the interval from env
 * (or `opts.intervalMs`), disabled (`<= 0`) short-circuits to a no-op
 * disposer, otherwise runs once after `initialDelayMs` then every
 * `intervalMs`. Returns a disposer that clears both the initial timeout and
 * the recurring interval — call it on shutdown.
 */
export function startPeriodicJob(opts: PeriodicJobOptions): () => void {
  const intervalMs = opts.intervalMs ?? periodicJobIntervalMs(opts.envVar, opts.defaultHours);
  const log = opts.log ?? ((line: string) => console.log(`[${opts.name}] ${line}`));

  if (intervalMs <= 0) {
    log(`scheduling disabled (${opts.envVar}=0)`);
    return () => {};
  }

  let interval: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    void opts.run().catch((e) => {
      log(`run failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  const timeout = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
  }, opts.initialDelayMs);

  return () => {
    clearTimeout(timeout);
    if (interval) clearInterval(interval);
  };
}
