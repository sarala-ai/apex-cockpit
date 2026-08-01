/**
 * How long an approval has been sitting on the founder.
 *
 * Deliberately NOT `relativeTime` ("3h ago"): a gate is not an event that
 * happened, it is a queue the founder is the bottleneck of. The phrasing says
 * so — "Waiting 3 hours" — and long waits are marked stale so the oldest gate
 * is visibly the oldest rather than just another timestamp.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A wait past this reads as neglected, not queued. */
export const STALE_WAIT_MS = DAY;

export type WaitingFor = {
  /** Human phrasing, e.g. "Waiting 3 hours". */
  label: string;
  ms: number;
  stale: boolean;
};

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * @param since ISO timestamp the gate started waiting, or null.
 * @param now injected for tests; defaults to the wall clock.
 * @returns null when there is nothing honest to say (no timestamp, an
 *   unparseable one, or a timestamp in the future — never a negative wait).
 */
export function formatWaitingFor(since: string | null | undefined, now: number = Date.now()): WaitingFor | null {
  if (!since) return null;
  const started = new Date(since).getTime();
  if (Number.isNaN(started)) return null;
  const ms = now - started;
  if (ms < 0) return null;

  let label: string;
  if (ms < MINUTE) label = "Waiting less than a minute";
  else if (ms < HOUR) label = `Waiting ${plural(Math.floor(ms / MINUTE), "minute")}`;
  else if (ms < DAY) label = `Waiting ${plural(Math.floor(ms / HOUR), "hour")}`;
  else label = `Waiting ${plural(Math.floor(ms / DAY), "day")}`;

  return { label, ms, stale: ms >= STALE_WAIT_MS };
}
