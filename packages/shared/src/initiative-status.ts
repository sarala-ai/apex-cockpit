import type { InitiativeDerivedStatus } from "./constants.js";

/**
 * Read an initiative's status off its projects.
 *
 * Computed at read time rather than cached: a cache would need invalidating on
 * every project create, status change, re-link and delete, and the first
 * missed path leaves a stored label that quietly contradicts the board. The
 * input is a handful of rows behind an indexed join — there is nothing here
 * worth trading correctness for.
 *
 * The rules, in order:
 *   - nothing decomposed yet → planned
 *   - every project cancelled → cancelled
 *   - every live project completed → delivered
 *   - anything completed or in progress → active (this is the common case:
 *     part delivered, the rest waiting, which is still an active initiative)
 *   - everything live on hold → on_hold
 *   - otherwise → planned
 */
export function deriveInitiativeStatus(
  projectStatuses: readonly string[],
): InitiativeDerivedStatus {
  if (projectStatuses.length === 0) return "planned";

  const live = projectStatuses.filter((status) => status !== "cancelled");
  if (live.length === 0) return "cancelled";

  if (live.every((status) => status === "completed")) return "delivered";
  if (live.some((status) => status === "completed" || status === "in_progress")) return "active";
  if (live.every((status) => status === "on_hold")) return "on_hold";

  return "planned";
}
