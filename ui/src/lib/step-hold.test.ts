/**
 * What a stopped step says.
 *
 * The failure this guards against is the one the product actually had: a step
 * fails, the server records exactly why, and the person is told nothing — or
 * told that something happened without being told what to do about it. Both
 * halves are asserted here, for every kind of hold the server can write.
 */
import { describe, expect, it } from "vitest";
import type { PipelineStepHold } from "@paperclipai/shared";
import {
  describeStepHold,
  STEP_HOLD_CONSEQUENCE,
  stoppedStepSectionLabel,
  summariseStepHold,
} from "./step-hold";

/** Every `reason` `writeStepHold` is called with today. */
const REASONS = [
  "run_exit_failure",
  "agent_step_failure",
  "acceptance_failed",
  "step_exit_transition_blocked",
];

function hold(overrides: Partial<PipelineStepHold> = {}): PipelineStepHold {
  return {
    eventId: "event-1",
    stageId: "stage-1",
    stageKey: "spec",
    stageName: "Spec",
    reason: "agent_step_failure",
    errorType: "run_cancelled",
    message: "Cancelled because issue assignee changed before the queued run could start",
    heldAt: "2026-07-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("describing a step that stopped", () => {
  it("says nothing when nothing is held", () => {
    expect(describeStepHold(null)).toBeNull();
    expect(describeStepHold(undefined)).toBeNull();
  });

  it("shows the server's recorded sentence verbatim — it is the only specific part", () => {
    const copy = describeStepHold(hold())!;
    expect(copy.detail).toBe(
      "Cancelled because issue assignee changed before the queued run could start",
    );
  });

  it("names the step when the reader needs the context, and omits it when they do not", () => {
    expect(describeStepHold(hold())!.headline).toContain("at Spec");
    // The item page already shows the step in its header; repeating it there
    // is noise, so the caller can suppress it.
    expect(describeStepHold(hold(), { stepName: null })!.headline).not.toContain("at Spec");
  });

  it("tells a person what to do, for every hold the server can write", () => {
    for (const reason of REASONS) {
      const copy = describeStepHold(hold({ reason }))!;
      expect(copy.nextStep, `${reason} said nothing actionable`).toContain("re-run this step");
      // The reason a hold is worth interrupting someone for.
      expect(copy.nextStep).toContain(STEP_HOLD_CONSEQUENCE);
    }
  });

  it("still says something when the hold was recorded without a message or a reason", () => {
    const copy = describeStepHold(hold({ reason: null, message: null, stageName: null }))!;
    expect(copy.detail).toBeNull();
    expect(copy.headline).toContain("needs you");
    expect(copy.nextStep.length).toBeGreaterThan(0);
  });

  it("never puts internal vocabulary in front of a reader", () => {
    for (const reason of REASONS) {
      const copy = describeStepHold(hold({ reason }))!;
      const text = `${copy.headline} ${copy.nextStep}`;
      for (const word of ["step_held", "onEnter", "stage config", "case", "acceptance_failed"]) {
        expect(text, `${reason} leaked "${word}"`).not.toContain(word);
      }
    }
  });
});

/**
 * The one-line form the attention surfaces use.
 *
 * The bar here is different from the ticket's: this has to interrupt somebody
 * who is looking at something else and be understood without a second line.
 * The assertions are therefore about what a person can identify from it — the
 * thing that stopped and the step it stopped at — and about the words the
 * product does not use in front of people.
 */
describe("summariseStepHold", () => {
  it("names the ticket and the step", () => {
    expect(summariseStepHold({
      stageName: "Spec",
      issueIdentifier: "APEX-14",
      issueTitle: "Make failure visible",
    })).toBe("APEX-14 stopped at Spec");
  });

  it("falls back to the title when a ticket has no identifier yet", () => {
    expect(summariseStepHold({
      stageName: "Spec",
      issueIdentifier: null,
      issueTitle: "Make failure visible",
    })).toBe("Make failure visible stopped at Spec");
  });

  it("still says something when nothing can be named", () => {
    expect(summariseStepHold({ stageName: null, issueIdentifier: null, issueTitle: null }))
      .toBe("Work stopped");
  });

  it("never leaks internal vocabulary", () => {
    const line = summariseStepHold({
      stageName: "Spec",
      issueIdentifier: "APEX-14",
      issueTitle: "t",
    });
    for (const word of ["step_held", "onEnter", "stage config", "case", "hold"]) {
      expect(line.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });
});

describe("stoppedStepSectionLabel", () => {
  it("counts in plain language", () => {
    expect(stoppedStepSectionLabel(1)).toBe("1 thing has stopped");
    expect(stoppedStepSectionLabel(3)).toBe("3 things have stopped");
  });
});
