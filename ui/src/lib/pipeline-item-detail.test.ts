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
