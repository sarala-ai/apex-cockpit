import { describe, expect, it } from "vitest";
import { STALE_WAIT_MS, formatWaitingFor } from "./approval-waiting";

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("formatWaitingFor", () => {
  it("says nothing rather than something false when there is no timestamp", () => {
    expect(formatWaitingFor(null, NOW)).toBeNull();
    expect(formatWaitingFor(undefined, NOW)).toBeNull();
    expect(formatWaitingFor("not a date", NOW)).toBeNull();
  });

  it("refuses to report a negative wait for a clock-skewed future timestamp", () => {
    expect(formatWaitingFor(new Date(NOW + 60_000).toISOString(), NOW)).toBeNull();
  });

  it("phrases the wait as a queue the founder is holding up", () => {
    expect(formatWaitingFor(ago(30_000), NOW)?.label).toBe("Waiting less than a minute");
    expect(formatWaitingFor(ago(60_000), NOW)?.label).toBe("Waiting 1 minute");
    expect(formatWaitingFor(ago(25 * 60_000), NOW)?.label).toBe("Waiting 25 minutes");
    expect(formatWaitingFor(ago(3 * 3_600_000), NOW)?.label).toBe("Waiting 3 hours");
    expect(formatWaitingFor(ago(2 * 86_400_000), NOW)?.label).toBe("Waiting 2 days");
  });

  it("marks a wait stale only once it crosses a day", () => {
    expect(formatWaitingFor(ago(STALE_WAIT_MS - 1000), NOW)?.stale).toBe(false);
    expect(formatWaitingFor(ago(STALE_WAIT_MS), NOW)?.stale).toBe(true);
  });

  it("carries the raw elapsed milliseconds for callers that want to sort", () => {
    expect(formatWaitingFor(ago(90_000), NOW)?.ms).toBe(90_000);
  });
});
