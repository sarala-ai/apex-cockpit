import { describe, expect, it, vi } from "vitest";
import { flowTickIntervalMs, startFlowCoordinatorSweep, FLOW_TICK_ENV_VAR } from "../apex/flow/sweep.js";
import type { FlowCoordinator } from "../apex/flow/coordinator.js";

describe("flowTickIntervalMs", () => {
  it("defaults to 5 minutes", () => {
    expect(flowTickIntervalMs({})).toBe(5 * 60_000);
  });

  it("honors APEX_FLOW_TICK_MINUTES", () => {
    expect(flowTickIntervalMs({ [FLOW_TICK_ENV_VAR]: "2" })).toBe(2 * 60_000);
  });

  it("0 disables (passed through)", () => {
    expect(flowTickIntervalMs({ [FLOW_TICK_ENV_VAR]: "0" })).toBe(0);
  });

  it("garbage/negative falls back to the default", () => {
    expect(flowTickIntervalMs({ [FLOW_TICK_ENV_VAR]: "nope" })).toBe(5 * 60_000);
    expect(flowTickIntervalMs({ [FLOW_TICK_ENV_VAR]: "-3" })).toBe(5 * 60_000);
  });
});

describe("startFlowCoordinatorSweep", () => {
  it("runs coordinator.sweep with the tick interval as staleness", async () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.fn(async () => ({ resumed: 0, agentRecovered: 0 }));
      const stop = startFlowCoordinatorSweep({} as never, {
        coordinator: { sweep } as unknown as FlowCoordinator,
        intervalMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(60_000); // initial delay = min(interval, 60s)
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
    const sweep = vi.fn(async () => ({ resumed: 0, agentRecovered: 0 }));
    const stop = startFlowCoordinatorSweep({} as never, {
      coordinator: { sweep } as unknown as FlowCoordinator,
      intervalMs: 0,
    });
    stop();
    expect(sweep).not.toHaveBeenCalled();
  });
});
