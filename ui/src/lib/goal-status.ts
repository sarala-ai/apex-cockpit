import type { Goal } from "@paperclipai/shared";

/**
 * The status to SHOW for a goal.
 *
 * For an initiative that is the derived reading — computed by the server from
 * the projects underneath it — because the stored `status` column is inert on
 * an initiative and would only ever be a stale second opinion. Falls back to
 * the stored value when a caller supplies a goal the server has not decorated
 * (fixtures, optimistic updates), so the row still renders something true of
 * the record rather than nothing.
 */
export function goalDisplayStatus(goal: Pick<Goal, "level" | "status" | "derivedStatus">): string {
  if (goal.level === "initiative" && goal.derivedStatus) return goal.derivedStatus;
  return goal.status;
}

/** True when the shown status came from the projects, not from the column. */
export function isDerivedGoalStatus(
  goal: Pick<Goal, "level" | "derivedStatus">,
): boolean {
  return goal.level === "initiative" && Boolean(goal.derivedStatus);
}
