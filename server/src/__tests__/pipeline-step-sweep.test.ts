/**
 * The pipeline step sweep — scheduling contract only.
 *
 * What the recovery DOES (following a retry chain, classifying a lost run,
 * holding rather than advancing) is exercised against a real database in
 * pipelines-step-config; this file pins the half that is easy to get wrong
 * without noticing: WHEN it runs, and that the staleness window handed to it
 * is the tick itself. A sweep that treats every parked case as stale on the
 * first tick would recover cases whose agent is still working.
 */
import { describe, expect, it, vi } from "vitest";
import {
  PIPELINE_STEP_TICK_ENV_VAR,
  pipelineStepTickIntervalMs,
  startPipelineStepSweep,
} from "../apex/pipeline/step-sweep.js";
import type { pipelineService } from "../services/pipelines.js";

describe("pipelineStepTickIntervalMs", () => {
  it("defaults to 5 minutes", () => {
    expect(pipelineStepTickIntervalMs({})).toBe(5 * 60_000);
  });

  it("honors APEX_PIPELINE_TICK_MINUTES", () => {
    expect(pipelineStepTickIntervalMs({ [PIPELINE_STEP_TICK_ENV_VAR]: "2" })).toBe(2 * 60_000);
  });

  it("0 disables, and only 0 disables", () => {
    expect(pipelineStepTickIntervalMs({ [PIPELINE_STEP_TICK_ENV_VAR]: "0" })).toBe(0);
    // Garbage must NOT disable the sweep — a typo in an env var should not
    // silently turn off the thing that stops cases stranding.
    expect(pipelineStepTickIntervalMs({ [PIPELINE_STEP_TICK_ENV_VAR]: "nope" })).toBe(5 * 60_000);
    expect(pipelineStepTickIntervalMs({ [PIPELINE_STEP_TICK_ENV_VAR]: "-3" })).toBe(5 * 60_000);
  });
});

describe("startPipelineStepSweep", () => {
  function serviceStub(sweep: ReturnType<typeof vi.fn>) {
    return { sweepWaitingAgentCases: sweep } as unknown as ReturnType<typeof pipelineService>;
  }

  it("sweeps on the tick, with the tick as the staleness window", async () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.fn(async () => ({ examined: 0, recovered: 0 }));
      const stop = startPipelineStepSweep({} as never, {
        service: serviceStub(sweep),
        intervalMs: 60_000,
      });
      // Nothing on boot: a server that just started has not had a chance to
      // observe anything, so every parked case would look stale at once.
      expect(sweep).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledWith(60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("interval 0 is a no-op", () => {
    const sweep = vi.fn(async () => ({ examined: 0, recovered: 0 }));
    const stop = startPipelineStepSweep({} as never, { service: serviceStub(sweep), intervalMs: 0 });
    stop();
    expect(sweep).not.toHaveBeenCalled();
  });
});
