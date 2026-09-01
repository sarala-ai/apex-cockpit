/**
 * Finding 8 (adversarial architecture review): shared scheduling helper
 * extracted from the ~30 duplicated lines in
 * observe/attribution-refresh.ts / apex/pipeline/github-issue-ingest.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { periodicJobIntervalMs, startPeriodicJob } from "../lib/periodic-job.js";

describe("periodicJobIntervalMs", () => {
  it("defaults to defaultHours when unset", () => {
    expect(periodicJobIntervalMs("SOME_HOURS", 6, {})).toBe(6 * 60 * 60 * 1000);
  });

  it("honors the env var", () => {
    expect(periodicJobIntervalMs("SOME_HOURS", 6, { SOME_HOURS: "2" })).toBe(2 * 60 * 60 * 1000);
  });

  it("returns 0 (disabled) when set to 0", () => {
    expect(periodicJobIntervalMs("SOME_HOURS", 6, { SOME_HOURS: "0" })).toBe(0);
  });

  it("falls back to the default on a garbage or negative value", () => {
    expect(periodicJobIntervalMs("SOME_HOURS", 6, { SOME_HOURS: "nope" })).toBe(6 * 60 * 60 * 1000);
    expect(periodicJobIntervalMs("SOME_HOURS", 6, { SOME_HOURS: "-1" })).toBe(6 * 60 * 60 * 1000);
  });
});

describe("startPeriodicJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule when intervalMs resolves to 0 (disabled)", () => {
    const run = vi.fn(async () => {});
    const log = vi.fn();
    const stop = startPeriodicJob({
      name: "test-job",
      envVar: "TEST_JOB_HOURS",
      defaultHours: 1,
      initialDelayMs: 1000,
      intervalMs: 0,
      log,
      run,
    });

    vi.advanceTimersByTime(10_000);

    expect(run).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([line]) => line.includes("TEST_JOB_HOURS"))).toBe(true);
    stop(); // no-op disposer, must not throw
  });

  it("runs once after initialDelayMs, then on every intervalMs", async () => {
    const run = vi.fn(async () => {});
    const stop = startPeriodicJob({
      name: "test-job",
      envVar: "TEST_JOB_HOURS",
      defaultHours: 1,
      initialDelayMs: 1000,
      intervalMs: 5000,
      log: () => {},
      run,
    });

    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run).toHaveBeenCalledTimes(3); // disposer actually clears the interval
  });

  it("logs a run failure instead of throwing it into the timer", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const lines: string[] = [];
    const stop = startPeriodicJob({
      name: "test-job",
      envVar: "TEST_JOB_HOURS",
      defaultHours: 1,
      initialDelayMs: 0,
      intervalMs: 5000,
      log: (line) => lines.push(line),
      run,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(lines.some((line) => line.includes("boom"))).toBe(true);
    stop();
  });
});
