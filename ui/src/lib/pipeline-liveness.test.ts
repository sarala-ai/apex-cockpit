/**
 * Which liveness states raise a banner on the pipeline item page, and what it
 * says.
 *
 * The gap this covers: a held step raised NOTHING. The server knew the step
 * had stopped and why, and the item page rendered "In progress · Stage: Spec"
 * with no sign of trouble — the reason being that liveness never reported the
 * hold, so the item fell through to `no_action_path` ("This item is stuck"),
 * which says nothing about what stopped or what to do.
 */
import { describe, expect, it } from "vitest";
import type { PipelineCaseLiveness } from "@paperclipai/shared";
import { derivePipelineLivenessBanner } from "./pipeline-liveness";

const HOLD = {
  eventId: "event-1",
  stageId: "stage-1",
  stageKey: "spec",
  stageName: "Spec",
  reason: "agent_step_failure",
  errorType: "run_cancelled",
  message: "Cancelled because issue assignee changed before the queued run could start",
  heldAt: "2026-07-27T10:00:00.000Z",
};

function held(overrides: Partial<PipelineCaseLiveness> = {}): PipelineCaseLiveness {
  return {
    state: "attention",
    reason: "step_held",
    message: HOLD.message,
    hold: HOLD,
    ...overrides,
  };
}

describe("a step that stopped", () => {
  it("raises a banner that says what stopped, why, and what to do", () => {
    const view = derivePipelineLivenessBanner(held())!;

    expect(view).not.toBeNull();
    expect(view.title).toContain("This stopped");
    // Not "at Spec" — the page header already says which step this is.
    expect(view.title).not.toContain("at Spec");
    expect(view.body).toContain("Cancelled because issue assignee changed before the queued run could start");
    expect(view.body).toContain("re-run this step");
    // And the affordance is offered right there, in the state it exists for.
    expect(view.showRetry).toBe(true);
    expect(view.retryKind).toBe("stage");
  });

  it("still raises a banner when the hold was recorded without a message", () => {
    const view = derivePipelineLivenessBanner(held({ hold: { ...HOLD, message: null, reason: null } }))!;
    expect(view.title.length).toBeGreaterThan(0);
    expect(view.body.length).toBeGreaterThan(0);
    expect(view.showRetry).toBe(true);
  });
});

describe("a step that is running", () => {
  it("raises nothing — a live commission is not trouble", () => {
    // It also outranks the hold on the server, so a re-run of a failed step
    // stops shouting the moment the fresh run starts.
    expect(derivePipelineLivenessBanner({
      state: "live",
      reason: "step_running",
      message: "An agent is working on this step now.",
    })).toBeNull();
  });
});
