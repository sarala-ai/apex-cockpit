/**
 * WHO a stopped step interrupts.
 *
 * The wrong answer here is the one that makes the whole signal useless: a
 * held step's owner is routinely an AGENT, and an agent cannot act on a badge
 * in somebody's sidebar. So the audience is the accountable human, resolved by
 * the ladder the codebase already uses for exactly this question — and the
 * bottom rung of that ladder is the load-bearing one, because a stopped step
 * that resolves to nobody is the original bug in a new place.
 */
import { describe, expect, it } from "vitest";
import { countStoppedStepsForUser, resolveStoppedStepAudience } from "../apex/pipeline/stopped-steps.js";
import type { StoppedStep } from "../apex/pipeline/stopped-steps.js";

describe("resolveStoppedStepAudience", () => {
  it("prefers the ticket's responsible human", () => {
    expect(resolveStoppedStepAudience(
      { responsibleUserId: "user-resp", createdByUserId: "user-creator" },
      "user-owner",
    )).toBe("user-resp");
  });

  it("falls back to whoever raised the ticket", () => {
    expect(resolveStoppedStepAudience(
      { responsibleUserId: null, createdByUserId: "user-creator" },
      "user-owner",
    )).toBe("user-creator");
  });

  it("falls back to the company's human when the ticket names none", () => {
    expect(resolveStoppedStepAudience(
      { responsibleUserId: null, createdByUserId: null },
      "user-owner",
    )).toBe("user-owner");
  });

  it("still resolves when there is no ticket at all", () => {
    expect(resolveStoppedStepAudience(null, "user-owner")).toBe("user-owner");
  });

  it("resolves to nobody only when the company itself names nobody", () => {
    expect(resolveStoppedStepAudience(null, null)).toBeNull();
  });
});

function step(responsibleUserId: string | null): StoppedStep {
  return {
    caseId: `case-${responsibleUserId ?? "none"}`,
    caseKey: "CASE-1",
    pipelineId: "pipeline-1",
    stageName: "Spec",
    issue: null,
    responsibleUserId,
    hold: {
      eventId: "event-1",
      stageId: "stage-1",
      stageKey: "spec",
      stageName: "Spec",
      reason: "agent_step_failure",
      errorType: null,
      message: "The agent's run did not complete",
      heldAt: "2026-07-27T10:00:00.000Z",
    },
  };
}

describe("countStoppedStepsForUser", () => {
  it("counts only what this person is answerable for", () => {
    const steps = [step("user-a"), step("user-b"), step("user-a")];
    expect(countStoppedStepsForUser(steps, "user-a")).toBe(2);
    expect(countStoppedStepsForUser(steps, "user-b")).toBe(1);
    expect(countStoppedStepsForUser(steps, "user-c")).toBe(0);
  });

  it("gives a non-user caller the company-wide total rather than zero", () => {
    // An agent or service key reading the badge endpoint has no personal
    // queue. Answering "0 things have stopped" would be a lie about the board.
    const steps = [step("user-a"), step("user-b")];
    expect(countStoppedStepsForUser(steps, null)).toBe(2);
  });

  it("is zero on a healthy board", () => {
    expect(countStoppedStepsForUser([], "user-a")).toBe(0);
  });
});
