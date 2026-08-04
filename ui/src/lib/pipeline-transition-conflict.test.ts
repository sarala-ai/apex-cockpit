/**
 * What a person is told when a move is refused.
 *
 * The behaviour worth protecting is that the server's REASON survives the trip
 * to the screen. Before this mapping every refusal became "Could not move the
 * item" (item page) or "This item changed while you were looking" (board) —
 * the second being an outright fabrication whenever the real cause was a held
 * step, which is the most common cause.
 *
 * Two rules run through every case below:
 *   - no internal vocabulary reaches the reader ("case", "stage config",
 *     "onEnter", "step_held", the raw code itself);
 *   - the body says what to DO, not only what happened.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { describeTransitionConflict } from "./pipeline-transition-conflict";

const FORBIDDEN_VOCABULARY = [
  "step_held",
  "acceptance_failed",
  "lease_held",
  "onEnter",
  "stage config",
  "stageId",
  "expectedVersion",
];

function conflict(code: string, message: string, details: Record<string, unknown> = {}) {
  return new ApiError(message, 409, { error: message, code, details: { code, ...details } });
}

describe("telling a person why a move was refused", () => {
  it("names a held step and points at the way out", () => {
    const copy = describeTransitionConflict(
      conflict(
        "stage_held",
        "Pipeline stage is held: Cancelled because issue assignee changed before the queued run could start",
        { reason: "agent_step_failure", errorType: "run_cancelled" },
      ),
    );

    expect(copy.title).toContain("this step stopped");
    // The server's own sentence survives, stripped of its internal prefix.
    expect(copy.body).toContain("Cancelled because issue assignee changed before the queued run could start");
    expect(copy.body).toContain("Re-run this step");
  });

  it("keeps the version-conflict wording the ticket surface already set", () => {
    const copy = describeTransitionConflict(
      conflict("version_conflict", "Pipeline case version conflict", { version: 7 }),
    );
    expect(copy.body).toBe("The process may have moved on since this page loaded. Reload and try again.");
  });

  it("names the child that is still open rather than saying 'children'", () => {
    const copy = describeTransitionConflict(
      conflict("children_not_terminal", 'Pipeline child case "Write the migration" is still open', {
        child: { title: "Write the migration" },
      }),
    );
    expect(copy.body).toContain('"Write the migration" is still open');
  });

  it("distinguishes an agent holding the work from a person holding it", () => {
    const byAgent = describeTransitionConflict(
      conflict("lease_held", "Pipeline case lease is held", { lease: { type: "agent" } }),
    );
    const byUser = describeTransitionConflict(
      conflict("lease_held", "Pipeline case lease is held", { lease: { type: "user" } }),
    );
    expect(byAgent.body).toContain("An agent has it checked out");
    expect(byUser.body).toContain("Somebody has it checked out");
  });

  it("says 'remove' when that is what the person was trying to do", () => {
    const copy = describeTransitionConflict(conflict("blocked", "Pipeline case is blocked"), {
      verb: "remove",
    });
    expect(copy.title).toContain("remove this item");
  });

  it("falls back to the server's own sentence for a code it does not know", () => {
    const copy = describeTransitionConflict(
      conflict("some_future_code", "Pipeline something entirely new went wrong"),
    );
    // Strictly more than a bare toast, even for a conflict this build predates.
    expect(copy.body).toBe("Something entirely new went wrong");
  });

  it("still says something useful when the server sent nothing at all", () => {
    const copy = describeTransitionConflict(new Error("network down"));
    expect(copy.title).toBe("Could not move this item");
    expect(copy.body.length).toBeGreaterThan(0);
  });

  it("never leaks internal vocabulary to the reader", () => {
    const codes = [
      "stage_held",
      "acceptance_failed",
      "acceptance_not_evaluated",
      "lease_held",
      "blocked",
      "children_not_terminal",
      "expected_children_mismatch",
      "unresolved_drift",
      "review_outdated",
      "transition_not_allowed",
      "version_conflict",
      "pipeline_archived",
      "autonomy_not_enabled",
    ];
    for (const code of codes) {
      const copy = describeTransitionConflict(conflict(code, "Pipeline something failed"));
      const text = `${copy.title} ${copy.body}`;
      for (const word of FORBIDDEN_VOCABULARY) {
        expect(text, `${code} leaked "${word}"`).not.toContain(word);
      }
      // Every refusal tells the person what to do next, not only what happened.
      expect(copy.body.trim().length, `${code} said nothing actionable`).toBeGreaterThan(20);
    }
  });
});
