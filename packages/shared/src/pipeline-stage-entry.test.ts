/**
 * The one spelling of "does this step run anything?".
 *
 * Five bugs came from independent copies of this predicate each knowing only
 * `routine`. The assertions that matter are therefore the two newer kinds and
 * the fail-closed cases: a helper that answered `true` for a half-written step
 * would send the retry machinery after something the executor will refuse.
 */
import { describe, expect, it } from "vitest";
import { stageEntryRoutineId, stageEntryStepRef, stageHasEntryStep } from "./pipeline-stage-entry.js";

const STAGE_ID = "stage-1";

describe("stageEntryStepRef", () => {
  it("reads a routine step, with its routine", () => {
    expect(stageEntryStepRef({ onEnter: { type: "routine", routineId: "r-1", id: "auto-1" } }, STAGE_ID))
      .toEqual({ id: "auto-1", kind: "routine", routineId: "r-1" });
  });

  it("reads a run step — the kind the stale readers missed", () => {
    expect(stageEntryStepRef(
      { onEnter: { type: "run", target: { type: "workflow", workflow: "deploy" } } },
      STAGE_ID,
    )).toEqual({ id: "stage-1:on_enter", kind: "run", routineId: null });
  });

  it("reads an agent step — the other kind the stale readers missed", () => {
    expect(stageEntryStepRef(
      { onEnter: { type: "agent", promptTemplate: "Fix the failing test." } },
      STAGE_ID,
    )).toEqual({ id: "stage-1:on_enter", kind: "agent", routineId: null });
  });

  it("defaults the step id to the ledger's historical shape", () => {
    expect(stageEntryStepRef({ onEnter: { type: "routine", routineId: "r-1" } }, STAGE_ID)?.id)
      .toBe("stage-1:on_enter");
  });

  it("fails closed on incomplete steps of every kind", () => {
    // A routine with no routine, a run with no target, an agent with no
    // prompt: each declares an intention it cannot execute, and reporting one
    // would offer a re-run the server refuses.
    expect(stageEntryStepRef({ onEnter: { type: "routine" } }, STAGE_ID)).toBeNull();
    expect(stageEntryStepRef({ onEnter: { type: "run" } }, STAGE_ID)).toBeNull();
    expect(stageEntryStepRef({ onEnter: { type: "agent", promptTemplate: "  " } }, STAGE_ID)).toBeNull();
  });

  it("fails closed on the pre-rename discriminator rather than guessing", () => {
    // `run_routine` is what migration 0170 rewrote AWAY. Data that still says
    // it is data the migration did not touch, and reading it as a live step
    // would resurrect the two-vocabulary problem the rename closed.
    expect(stageEntryStepRef({ onEnter: { type: "run_routine", routineId: "r-1" } }, STAGE_ID)).toBeNull();
  });

  it("returns null for no config, no onEnter, and non-object shapes", () => {
    expect(stageEntryStepRef(null, STAGE_ID)).toBeNull();
    expect(stageEntryStepRef({}, STAGE_ID)).toBeNull();
    expect(stageEntryStepRef({ onEnter: "routine" }, STAGE_ID)).toBeNull();
    expect(stageEntryStepRef({ onEnter: [] }, STAGE_ID)).toBeNull();
  });
});

describe("stageHasEntryStep / stageEntryRoutineId", () => {
  it("agree with the ref they wrap", () => {
    const run = { onEnter: { type: "run", target: { type: "workflow", workflow: "w" } } };
    expect(stageHasEntryStep(run, STAGE_ID)).toBe(true);
    expect(stageEntryRoutineId(run, STAGE_ID)).toBeNull();
    expect(stageEntryRoutineId({ onEnter: { type: "routine", routineId: "r-9" } }, STAGE_ID)).toBe("r-9");
    expect(stageHasEntryStep({}, STAGE_ID)).toBe(false);
  });
});
