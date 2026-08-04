/**
 * What the item's history says about the moment work stopped.
 *
 * These events already existed and already carried the truth — `step_held`
 * with the recorded reason, `acceptance_evaluated` with the verdict — and the
 * timeline rendered every one of them as its catch-all, "Activity recorded."
 * A case could be visibly stuck with a history that never said it stopped.
 */
import { describe, expect, it } from "vitest";
import type { PipelineCaseEvent } from "../api/pipelines";
import { formatPipelineItemEvent } from "./pipeline-item-detail";

function event(type: string, payload: Record<string, unknown> = {}): PipelineCaseEvent {
  return {
    id: "event-1",
    caseId: "case-1",
    type,
    actorType: "system",
    payload,
    createdAt: "2026-07-27T10:00:00.000Z",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("the events a stopped step writes", () => {
  it("says a step stopped, and quotes the recorded reason", () => {
    expect(formatPipelineItemEvent(event("step_held", {
      reason: "agent_step_failure",
      message: "Cancelled because issue assignee changed before the queued run could start",
    }))).toBe(
      "This step stopped — Cancelled because issue assignee changed before the queued run could start.",
    );
  });

  it("still says it stopped when no reason was recorded", () => {
    expect(formatPipelineItemEvent(event("step_held", { reason: "run_exit_failure" })))
      .toBe("This step stopped and is waiting for someone.");
  });

  it("says when the hold cleared, so the history reads as a loop that closed", () => {
    expect(formatPipelineItemEvent(event("step_hold_cleared", { reason: "run_exit_success" })))
      .toBe("The step is unstuck and the work can carry on.");
  });

  it("reports the server's verdict on the step in both directions", () => {
    expect(formatPipelineItemEvent(event("acceptance_evaluated", { ok: true })))
      .toBe("Checked against what this step asks for — passed.");
    expect(formatPipelineItemEvent(event("acceptance_evaluated", { ok: false, message: "no pull request found" })))
      .toBe("Checked against what this step asks for — not met: no pull request found.");
  });

  it("says when work was handed to an agent and picked back up", () => {
    expect(formatPipelineItemEvent(event("step_waiting"))).toBe("Handed to an agent to work on.");
    expect(formatPipelineItemEvent(event("step_resumed"))).toBe("Picked back up after the agent's run.");
  });

  it("keeps the catch-all for events it genuinely has nothing to say about", () => {
    expect(formatPipelineItemEvent(event("something_new"))).toBe("Activity recorded.");
  });
});

/**
 * The rest of the timeline's silent events, found by listing every type the
 * pipeline service writes against every type this function reads.
 */
describe("the events that were rendering as a shrug", () => {
  const stages = new Map([["review", "Review"], ["spec", "Spec"]]);

  it("says plainly when somebody moved an item past the process's own route", () => {
    // The most audit-relevant event an item can carry, and it read as
    // "Activity recorded."
    const text = formatPipelineItemEvent(
      {
        ...event("transition_forced", { reason: "Unblocking the release" }),
        actorType: "user",
        fromStageId: "spec",
        toStageId: "review",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      stages,
    );
    expect(text).toContain("Moved by hand from Spec to Review");
    expect(text).toContain("past the route this process defines");
    expect(text).toContain("Unblocking the release");
  });

  it("carries the gate's own question when a decision opened", () => {
    expect(formatPipelineItemEvent(event("gate_opened", { prompt: "Is it worth doing?" })))
      .toBe("Waiting for a decision: Is it worth doing?");
    expect(formatPipelineItemEvent(event("gate_opened", {}))).toBe("Waiting for a decision.");
  });

  it("distinguishes asking for a re-run from the run actually starting", () => {
    expect(formatPipelineItemEvent(event("automation_retry_requested", { targetStageKey: "spec" }), stages))
      .toBe("Asked to run Spec again.");
    expect(formatPipelineItemEvent(event("automation_retry_dispatched", { targetStageKey: "spec" }), stages))
      .toBe("Started a fresh run of Spec.");
  });

  it("counts what a re-run threw away, since that is the part worth checking", () => {
    expect(formatPipelineItemEvent(event("automation_effects_retired", {
      retiredCaseIds: ["a", "b"],
      cancelledIssueIds: ["c"],
    }))).toBe("Cleared out 2 items built from it and 1 task before the fresh run.");
  });
});
