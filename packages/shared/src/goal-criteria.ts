import type { GoalValidationCriterion } from "./validators/goal.js";

/**
 * Pure predicates over a validation criterion, shared by the server sweep and
 * the UI. Both have to agree on what "overdue" means — a criterion the board
 * paints red but the monitor never surfaces is the unread criterion wearing a
 * different colour — so the rule lives in one place.
 */

/** Milliseconds since the epoch for an ISO date/timestamp, or null if unusable. */
export function criterionDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Has this criterion's review date arrived while it is still unreported?
 *
 * A bare `YYYY-MM-DD` parses as UTC midnight, so "due today" is true from the
 * start of the day — the reader is prompted on the day they said they would
 * look, not the day after.
 */
export function isCriterionDue(
  criterion: Pick<GoalValidationCriterion, "status" | "reviewDate">,
  now: Date = new Date(),
): boolean {
  if (criterion.status !== "pending") return false;
  const due = criterionDateMs(criterion.reviewDate);
  if (due === null) return false;
  return due <= now.getTime();
}

/** Due, and not yet surfaced to its owner. This is what the sweep acts on. */
export function needsSurfacing(
  criterion: Pick<GoalValidationCriterion, "status" | "reviewDate" | "surfacedAt">,
  now: Date = new Date(),
): boolean {
  if (criterion.surfacedAt) return false;
  return isCriterionDue(criterion, now);
}

/** Stable key for the notification raised against one criterion. */
export function criterionReviewKey(goalId: string, criterionId: string): string {
  return `criterion-review:${goalId}:${criterionId}`;
}
