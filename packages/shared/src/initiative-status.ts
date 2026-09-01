import type { InitiativeDerivedStatus } from "./constants.js";

/** How the projects under one initiative are distributed. */
export interface InitiativeProjectCounts {
  /** Every project linked to the initiative, whatever its status. */
  total: number;
  /** Still in play: not cancelled, not folded away. */
  live: number;
  /** Built AND exercised. */
  completed: number;
  /** Built, never exercised — the count that keeps `delivered` honest. */
  built: number;
  inProgress: number;
  onHold: number;
  /** Backlog or planned: decomposed but not started. */
  notStarted: number;
  /** Abandoned. The stated outcome went away with nothing carrying it. */
  cancelled: number;
  /** Moved somewhere named. The outcome is still pursued, elsewhere. */
  folded: number;
}

/** Count the projects under an initiative by what their status means. */
export function summarizeInitiativeProjects(
  projectStatuses: readonly string[],
): InitiativeProjectCounts {
  const count = (...statuses: string[]) =>
    projectStatuses.filter((status) => statuses.includes(status)).length;
  const cancelled = count("cancelled");
  const folded = count("folded");
  return {
    total: projectStatuses.length,
    live: projectStatuses.length - cancelled - folded,
    completed: count("completed"),
    built: count("built"),
    inProgress: count("in_progress"),
    onHold: count("on_hold"),
    notStarted: count("backlog", "planned"),
    cancelled,
    folded,
  };
}

/**
 * Read an initiative's status off its projects — unless a person has said
 * otherwise.
 *
 * Computed at read time rather than cached: a cache would need invalidating on
 * every project create, status change, re-link and delete, and the first
 * missed path leaves a stored label that quietly contradicts the board. The
 * input is a handful of rows behind an indexed join — there is nothing here
 * worth trading correctness for.
 *
 * THE ONE THING THAT IS NOT DERIVED IS A HOLD. "We decided to pause this" is a
 * decision, exactly like `closure`, and no arrangement of child rows can
 * express it: APEX's "Zero-token agents" and "A new project starts from a
 * template" both read `active` off their projects — two of each one's projects
 * had completed — when the honest reading was *valid, not now*. When the goal
 * carries a `hold` marker it OVERRIDES the derivation, on the same principle
 * that already separates derived status from decided closure. The projects
 * keep their own statuses and the counts stay true, so nothing is lost by the
 * override; the reading is simply told the thing the rows do not contain.
 *
 * The rules, in order:
 *   - a hold was asserted → on_hold, whatever the projects say
 *   - nothing decomposed yet → planned
 *   - nothing live left → cancelled
 *   - every live project built or completed, with a cancellation behind it →
 *     partial
 *   - every live project built or completed → delivered
 *   - anything built, completed or in progress → active (the common case:
 *     part delivered, the rest waiting, which is still an active initiative)
 *   - everything live on hold → on_hold
 *   - otherwise → planned
 *
 * CANCELLED AND FOLDED ARE BOTH OUT OF THE LIVE SET; ONLY CANCELLED MAKES THE
 * READING PARTIAL. A cancellation removed a stated outcome with nothing
 * carrying it, so an initiative with one behind it may not claim plain
 * `delivered` — that is the MCP-first bug, where two failed projects vanished
 * from the reading and the board reported completeness for a sentence that had
 * been falsified. A fold is a different fact: the outcome moved to a named
 * project or initiative and is still being pursued, and the link says where,
 * so it redirects the reader instead of misleading them. Both counts are
 * rendered either way, so neither disappears from the board.
 *
 * `built` counts toward delivery. At the initiative level `delivered` has
 * always meant *the projects are done*, never *this was worth doing* — that is
 * `closure: validated`. Withholding delivery for an unexercised project would
 * blur the one distinction the model keeps sharpest; the built count is
 * surfaced beside the status instead.
 */
export function deriveInitiativeStatus(
  projectStatuses: readonly string[],
  options: { held?: boolean } = {},
): InitiativeDerivedStatus {
  if (options.held) return "on_hold";
  if (projectStatuses.length === 0) return "planned";

  const counts = summarizeInitiativeProjects(projectStatuses);
  const live = projectStatuses.filter(
    (status) => status !== "cancelled" && status !== "folded",
  );
  if (live.length === 0) return "cancelled";

  const isDelivered = (status: string) => status === "completed" || status === "built";
  if (live.every(isDelivered)) return counts.cancelled > 0 ? "partial" : "delivered";
  if (live.some((status) => isDelivered(status) || status === "in_progress")) return "active";
  if (live.every((status) => status === "on_hold")) return "on_hold";

  return "planned";
}
