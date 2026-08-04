/**
 * Why a move was refused, in words.
 *
 * `POST /cases/:id/transition` answers a refusal with a structured conflict —
 * a code, a message, and the specifics behind it (which child is still open,
 * what the step was asked to satisfy, who holds the lease). The item page threw
 * all of it away and rendered "Could not move the item", which tells a person
 * neither what stopped them nor what would unstop them. The server was never
 * the problem; there was no reader.
 *
 * The bar this is written to is the ticket surface's handling of a version
 * conflict — "The process may have moved on since this page loaded. Reload and
 * try again." That one sentence says what happened AND what to do. Every code
 * below is held to the same shape.
 *
 * Unknown codes are not a failure mode to hide: an unrecognised conflict falls
 * back to the server's own message with its internal prefix stripped, which is
 * still strictly more than a bare toast, and to a generic line only when the
 * server sent no message at all.
 */
import { ApiError } from "../api/client";

export interface TransitionConflictCopy {
  /** Toast title / heading. What happened. */
  title: string;
  /** The sentence under it. What to do about it — never omitted. */
  body: string;
}

function readDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof ApiError)) return {};
  const body = error.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const details = (body as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Record<string, unknown>
    : {};
}

function readCode(error: unknown): string | null {
  const details = readDetails(error);
  if (typeof details.code === "string" && details.code.trim()) return details.code.trim();
  if (error instanceof ApiError && error.body && typeof error.body === "object") {
    const code = (error.body as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * The server's own sentence, stripped of the internal prefix every pipeline
 * conflict carries ("Pipeline stage is held: …"). What survives is the part
 * that describes THIS failure, which is the part worth showing.
 */
function serverSentence(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const message = error.message?.trim();
  if (!message) return null;
  const stripped = message
    .replace(/^Pipeline\s+/i, "")
    .replace(/^stage is held:\s*/i, "")
    .replace(/^stage acceptance is not satisfied:\s*/i, "")
    .trim();
  if (!stripped) return null;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Translate a refused transition into a title and a next step.
 *
 * `verb` lets the same mapping serve "move" and "remove", which fail through
 * exactly the same gates for exactly the same reasons — the only difference is
 * what the person was trying to do.
 */
export function describeTransitionConflict(
  error: unknown,
  options: { verb?: "move" | "remove" } = {},
): TransitionConflictCopy {
  const verb = options.verb ?? "move";
  const noun = verb === "remove" ? "remove this item" : "move this item";
  const details = readDetails(error);
  const sentence = serverSentence(error);

  switch (readCode(error)) {
    // The step stopped and has not been dealt with. The single most likely
    // reason a person is trying to force a move in the first place.
    case "stage_held":
      return {
        title: `Could not ${noun} — this step stopped and has not been sorted out`,
        body: sentence
          ? `${sentence} Re-run this step, or deal with what stopped it first — the process will not let work past a step that failed.`
          : "Re-run this step, or deal with what stopped it first — the process will not let work past a step that failed.",
      };

    case "acceptance_failed":
      return {
        title: `Could not ${noun} — the work does not yet meet what this step asks for`,
        body: sentence
          ? `${sentence} Put that right and re-run this step; the check runs again on its own.`
          : "Put right what the step is asking for and re-run this step; the check runs again on its own.",
      };

    case "acceptance_not_evaluated":
      return {
        title: `Could not ${noun} — this step has not been checked yet`,
        body: "Nothing leaves this step until it has been checked against what the step asks for. Re-run this step to have it checked now.",
      };

    // The lease payload carries ids and an expiry, never a display name, so
    // the wording names the KIND of holder rather than inventing a lookup this
    // module has no way to do.
    case "lease_held": {
      const holderType = readString((details.lease as Record<string, unknown> | undefined)?.type);
      return {
        title: `Could not ${noun} — something else is working on it`,
        body: holderType === "agent"
          ? "An agent has it checked out right now. Wait for that run to finish and try again."
          : holderType === "user"
            ? "Somebody has it checked out right now. Wait for them to finish, or ask them to hand it back."
            : "It is checked out right now. Wait for that work to finish and try again.",
      };
    }

    case "blocked":
      return {
        title: `Could not ${noun} — it is waiting on other work`,
        body: "Finish or remove whatever this is waiting on, then try again. Waiting items are listed on this page.",
      };

    case "children_not_terminal": {
      const child = readString((details.child as Record<string, unknown> | undefined)?.title);
      return {
        title: `Could not ${noun} — the work built from it is not finished`,
        body: child
          ? `"${child}" is still open. Finish or remove the outstanding pieces, then try again.`
          : "Some of the pieces built from this item are still open. Finish or remove them, then try again.",
      };
    }

    case "expected_children_mismatch":
      return {
        title: `Could not ${noun} — the pieces built from it do not add up`,
        body: "This step expected a different number of pieces than were created. Re-run this step to build them again.",
      };

    case "unresolved_drift":
      return {
        title: `Could not ${noun} — upstream work changed`,
        body: "Something this was built from has changed since. Review the change and acknowledge it on this page, then try again.",
      };

    case "review_outdated":
      return {
        title: `Could not ${noun} — it changed after it was approved`,
        body: "The approval no longer covers what this item now says. Send it back through review before it goes any further.",
      };

    case "transition_not_allowed":
      return {
        title: `Could not ${noun} — the process does not allow that move`,
        body: "This process does not connect those two steps. Pick a step it can move to, or change the process if the route should exist.",
      };

    case "version_conflict":
      return {
        title: `Could not ${noun}`,
        body: "The process may have moved on since this page loaded. Reload and try again.",
      };

    case "pipeline_archived":
      return {
        title: `Could not ${noun} — this board is archived`,
        body: "Nothing moves on an archived board. Restore it first if this item still needs work.",
      };

    case "autonomy_not_enabled":
      return {
        title: `Could not ${noun} — that move is only the process's to make`,
        body: "This move is one the process makes on its own. Let it run, or re-run the step that should trigger it.",
      };

    default:
      break;
  }

  // A version conflict is reported as a plain 409 with no code from the
  // optimistic-concurrency path, and it is the single most common refusal, so
  // it gets the precedent wording rather than the generic fallback.
  if (error instanceof ApiError && error.status === 409 && !readCode(error)) {
    return {
      title: `Could not ${noun}`,
      body: sentence ?? "The process may have moved on since this page loaded. Reload and try again.",
    };
  }

  return {
    title: `Could not ${noun}`,
    body: sentence ?? "Something stopped this from going through. Reload the page and try again.",
  };
}
