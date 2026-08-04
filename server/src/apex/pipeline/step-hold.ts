/**
 * A stopped step, shaped for the surfaces a person actually reads.
 *
 * The fact already exists and is already load-bearing: `writeStepHold` records
 * it the moment a run, an agent step or an acceptance contract fails, and
 * `assertStageTransitionGates` refuses every transition out of the step while
 * it stands. What it never had was a READER. A case would sit at a step
 * reporting "In progress", the re-run affordance greyed out, and the only way
 * to learn why was to read `pipeline_case_events` by hand.
 *
 * This module is the seam between the event and the reader. It does the
 * shaping only — no wording lives here. The words are the client's
 * (`ui/src/lib/step-hold.ts`), so the ticket and the pipeline item page say the
 * same thing about the same hold rather than drifting into two vocabularies.
 */
import type { PipelineStepHold } from "@paperclipai/shared";

/** The stored `step_held` event, as little of it as this needs. */
export interface StepHoldEventRow {
  id: string;
  payload: unknown;
  createdAt: Date;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Shape a recorded hold, or null when the row is absent.
 *
 * Every field but `eventId`/`heldAt` is nullable on purpose: a hold written by
 * a code path that recorded no message is still a hold, and the reader must
 * say "this stopped" rather than say nothing because a field was missing.
 */
export function shapeStepHold(
  event: StepHoldEventRow | null | undefined,
  extra?: { stageName?: string | null },
): PipelineStepHold | null {
  if (!event) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  return {
    eventId: event.id,
    stageId: readString(payload.stageId),
    stageKey: readString(payload.stageKey),
    stageName: extra?.stageName ?? null,
    reason: readString(payload.reason),
    errorType: readString(payload.errorType),
    message: readString(payload.message),
    heldAt: event.createdAt.toISOString(),
  };
}
