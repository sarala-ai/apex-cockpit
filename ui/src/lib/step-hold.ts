/**
 * What a stopped step SAYS, in one place.
 *
 * The server records a hold as a fact with a code (`acceptance_failed`,
 * `agent_step_failure`, …) and a sentence. Neither is showable: the code is
 * internal vocabulary, and the sentence on its own answers "what happened"
 * while leaving "so what do I do" unanswered — which is the half that makes a
 * hold actionable rather than merely visible.
 *
 * Both surfaces that report a hold — the TICKET (`IssueLifecycle`) and the
 * pipeline ITEM page (`PipelineLivenessBanner`) — read their words from here.
 * One wording, deliberately: the previous state of the world was a hold that
 * appeared on neither, and the failure mode after that is a hold that appears
 * on both saying two different things.
 *
 * Three parts, always:
 *   headline — that it stopped, and roughly what kind of thing stopped it.
 *   detail   — the server's own recorded sentence, verbatim. The only part
 *              that says what actually went wrong on THIS item.
 *   nextStep — what a person can do about it. Never omitted: a hold nobody
 *              can act on is only marginally better than silence.
 */
import type { PipelineStepHold } from "@paperclipai/shared";

export interface StepHoldCopy {
  headline: string;
  /** The recorded reason, or null when the hold was written without one. */
  detail: string | null;
  nextStep: string;
}

/**
 * The consequence line, and the reason a hold is worth interrupting someone
 * for: nothing downstream happens until it is resolved.
 */
export const STEP_HOLD_CONSEQUENCE = "Nothing moves on from here until this is sorted out.";

const RERUN_ADVICE =
  "Once you have dealt with the cause, re-run this step from the actions menu — or move it on by hand if it no longer needs to run.";

function headlineFor(reason: string | null, stepName: string | null): string {
  const at = stepName ? ` at ${stepName}` : "";
  switch (reason) {
    case "acceptance_failed":
      return `This stopped${at} — the work did not meet what the step asks for`;
    case "run_exit_failure":
      return `This stopped${at} — an automated check did not pass`;
    case "agent_step_failure":
      return `This stopped${at} — the agent's run did not complete`;
    case "step_exit_transition_blocked":
      return `This finished${at} but could not move on`;
    default:
      return `This stopped${at} and needs you`;
  }
}

function nextStepFor(reason: string | null): string {
  switch (reason) {
    case "acceptance_failed":
      return `Put right what the step is asking for, then re-run this step from the actions menu. ${STEP_HOLD_CONSEQUENCE}`;
    case "step_exit_transition_blocked":
      return `Clear whatever is standing in the way of the next step, then re-run this step from the actions menu. ${STEP_HOLD_CONSEQUENCE}`;
    default:
      return `${RERUN_ADVICE} ${STEP_HOLD_CONSEQUENCE}`;
  }
}

/**
 * The one line a LIST gets.
 *
 * The ticket and the item page have room for three lines because you are
 * already looking at the thing. The inbox, the sidebar and the dashboard do
 * not: they have to interrupt somebody who is looking at something else, in
 * about eight words, and then get out of the way. So this is the headline's
 * job compressed — what stopped, and where — with the recorded reason and the
 * advice left for the surface you land on.
 *
 * It lives beside `describeStepHold` rather than in the inbox because the
 * failure mode is the same one that module was written for: two surfaces
 * describing one hold in two vocabularies.
 */
export function summariseStepHold(input: {
  stageName: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
}): string {
  const at = input.stageName ? ` at ${input.stageName}` : "";
  const subject = input.issueIdentifier ?? input.issueTitle;
  return subject ? `${subject} stopped${at}` : `Work stopped${at}`;
}

/** The heading a list of stopped work sits under, and the count beside it. */
export function stoppedStepSectionLabel(count: number): string {
  return count === 1 ? "1 thing has stopped" : `${count} things have stopped`;
}

/**
 * Turn a recorded hold into the three lines a person reads.
 *
 * `stepName` is passed by the caller rather than taken from the hold because
 * the ticket knows the step's display name from its lifecycle row while the
 * item page already has the stage in hand; the hold itself only reliably
 * carries a key, and a key is not a name.
 */
export function describeStepHold(
  hold: PipelineStepHold | null | undefined,
  options: { stepName?: string | null } = {},
): StepHoldCopy | null {
  if (!hold) return null;
  // `in` rather than `??`: passing `stepName: null` means "do not name the
  // step, the surface already has", which is a different instruction from
  // omitting it and must not fall back to the hold's own name.
  const stepName = "stepName" in options ? options.stepName ?? null : hold.stageName ?? null;
  return {
    headline: headlineFor(hold.reason, stepName),
    detail: hold.message?.trim() ? hold.message.trim() : null,
    nextStep: nextStepFor(hold.reason),
  };
}
