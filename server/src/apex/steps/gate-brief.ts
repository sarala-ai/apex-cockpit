/**
 * The DECISION BRIEF for a pipeline gate.
 *
 * Why this exists (founder critique, verbatim): *"Why does the gate get a
 * one-line brief? Why isn't it able to summarize or hand content from the
 * previous task for review and approval in a humane fashion?"*
 *
 * A gate used to show one string — the `gate.prompt` written at seed time,
 * knowing nothing about the ticket in front of it ("Gate 1: Promote — is it
 * worth doing. Seconds."). A person then approved on a label. That is how a
 * gate hollows into ceremony, and the whole operating model leans on these
 * gates.
 *
 * THE BAR: hand the reviewer the artifact, do not paraphrase it. Every
 * sentence below is DETERMINISTIC ASSEMBLY of records that already exist —
 * the step that ran, the document it wrote, the verdict the server recorded,
 * the rounds already spent. NO MODEL CALL happens anywhere on this path and
 * none may be added to it. If a generated summary layer is ever wanted, it
 * goes BESIDE the artifact, labelled as generated, and never replaces it.
 *
 * Five things, in the order a person decides:
 *   1. what is being decided   — the question, and where each answer sends it,
 *                                in the pipeline's OWN names for its steps.
 *   2. what the last step made — the document, the pull request, the closing
 *                                note. Excerpted honestly, one click from the
 *                                whole thing. Absence STATED, never blank.
 *   3. what was already checked — the server's own acceptance verdict, with
 *                                whether it still covers the current version.
 *   4. what changes the decision — rounds already spent here, how long this
 *                                has waited, decisions already taken.
 *   5. the review passes        — carried as questions, recorded, never
 *                                required (docs/architecture/review-passes.md).
 *
 * This module is PURE and SYNCHRONOUS over pre-read facts
 * (`GateBriefFacts`, gathered by ../pipeline/gate-brief-facts.ts). That is
 * deliberate: every branch — entry gate, agent step with a document, agent
 * step with nothing, a gate re-entered after changes were asked for — is
 * directly testable without a database, and the assembly cannot acquire an
 * I/O dependency by accident.
 *
 * HUMANE, concretely, matching ui/src/lib/step-hold.ts's tone: plain
 * language, no internal vocabulary (no "case", no "stage config", no
 * "onEnter", no event-type names, no UUIDs) anywhere a person reads. Machine
 * strings still travel — under `checked.machine` and `machine` — because
 * hiding them would be a different dishonesty; they are just never the
 * headline.
 */
import { reviewPassCatalogFor, type ReviewPass } from "./review-passes.js";

// ---------------------------------------------------------------------------
// Facts — what the reader must gather before anything can be assembled
// ---------------------------------------------------------------------------

/** A document the upstream step wrote, already excerpted by the reader. */
export type GateBriefDocument = {
  /** The document's key (`spec`, `plan`, …). Used for the link anchor. */
  key: string;
  title: string | null;
  /** The document body, cut to a readable length by the reader. */
  excerpt: string;
  /** true when `excerpt` is not the whole body. */
  truncated: boolean;
  updatedAt: string | null;
};

/** What the step immediately before this gate did, and what it left behind. */
export type GateBriefUpstreamFacts = {
  stepKey: string;
  /** The pipeline's own display name for that step. */
  stepName: string;
  kind: "run" | "agent" | "gate";
  /** Display name of whoever executed it, when it was an agent step. */
  actorName: string | null;
  finishedAt: string | null;
  documents: GateBriefDocument[];
  /** A pull request the step was required to open, when it declared one. */
  pullRequest: { repo: string; head: string; url: string | null } | null;
  /** The closing note the run left on the conversation, when it left one. */
  closingNote: { excerpt: string; truncated: boolean; at: string | null } | null;
  /** A workflow/command a `run` step invoked — named so the reader knows what
   *  produced the state they are approving. */
  ranWhat: string | null;
};

/** The server's own acceptance verdict for the step before this gate. */
export type GateBriefAcceptanceFacts = {
  criteria: string;
  ok: boolean;
  message: string | null;
  evaluation: string | null;
  /** false when the verdict was recorded against an older version of the work
   *  than the one now on screen — which makes it evidence about something
   *  else, and must be said out loud. */
  coversCurrentWork: boolean;
  evaluatedAt: string | null;
};

/** One round of "send it back" already spent at THIS decision. */
export type GateBriefRound = {
  round: number;
  /** What was asked for, verbatim. Null when the round recorded no reason. */
  askedFor: string | null;
  at: string | null;
};

/** A decision already taken elsewhere on this piece of work. */
export type GateBriefPriorDecision = {
  stepName: string;
  decision: "approve" | "reject" | "request_changes";
  at: string | null;
};

export type GateBriefTicketFacts = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  /** The `## Acceptance Criteria` section of the description, when it has one. */
  acceptanceSection: string | null;
  ticketType: string | null;
  /** The repository or folder the work lands in, when the project names one. */
  codebase: string | null;
};

export type GateBriefFacts = {
  approvalId: string;
  caseId: string;
  /** The version of the work the verdicts below are compared against. */
  workVersion: number;
  pipeline: { key: string; name: string };
  decision: {
    stepKey: string;
    stepName: string;
    /** The question whoever built this process wrote. Null when none. */
    question: string | null;
    /** Review-pass ids this decision asks for. */
    reviewPassIds: string[];
    approveToStepName: string | null;
    rejectToStepName: string | null;
    /** Null when there is no earlier step that could redo the work — then
     *  "send it back" genuinely is not on offer here. */
    requestChangesToStepName: string | null;
    openedAt: string | null;
  };
  ticket: GateBriefTicketFacts | null;
  /**
   * The step immediately before this decision, or null when this decision IS
   * the first thing the process does (the Feature lifecycle's Promote). Null
   * is a designed case, not a missing one — see `assembleGateBrief`.
   */
  upstream: GateBriefUpstreamFacts | null;
  acceptance: GateBriefAcceptanceFacts | null;
  rounds: GateBriefRound[];
  priorDecisions: GateBriefPriorDecision[];
  /** Injected so "waiting 3 hours" is testable. */
  now: string;
};

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

export type GateBriefOutcome = {
  decision: "approve" | "request_changes" | "reject";
  line: string;
};

/** One thing to look at, with the artifact itself or an honest excerpt. */
export type GateBriefLookAtItem = {
  /** What this is, in the reader's words ("Spec", "The pull request"). */
  label: string;
  /** The artifact's own text. Null when there is no text to show (a link-only
   *  artifact such as a pull request). */
  excerpt: string | null;
  truncated: boolean;
  /** Where the whole thing lives. `anchor` is a document key on the ticket
   *  page; `url` is somewhere else entirely. Never both. */
  anchor: string | null;
  url: string | null;
  /** The one line under the link — who wrote it and when. */
  meta: string | null;
};

export type GateBriefReviewPass = { id: string; label: string; question: string };

export type PipelineGateBrief =
  | { available: false; reason: string }
  | {
      available: true;
      kind: "pipeline_gate";
      /** 1 — what is being decided. */
      deciding: {
        headline: string;
        /** The question the process itself asks, verbatim, or null. */
        question: string | null;
        subject: string;
        ticketIdentifier: string | null;
        ticketId: string | null;
        outcomes: GateBriefOutcome[];
        /** "Waiting 3 hours for this decision." Null when the wait is unknown. */
        waitingFor: string | null;
      };
      /** 2 — what the last step produced. */
      lookAt: {
        headline: string;
        items: GateBriefLookAtItem[];
        /** Said out loud when there is nothing to show. Null when there is. */
        nothingThere: string | null;
      };
      /** 3 — what was already checked, machine-checked and labelled as such. */
      checked: {
        headline: string;
        /** true = passed, false = failed, null = nothing was checked. */
        ok: boolean | null;
        detail: string | null;
        /** Raw criteria/verdict strings — a details affordance, never a headline. */
        machine: string[];
      };
      /** 4 — history that changes the decision. Empty when nothing does. */
      history: string[];
      /** 5 — the questions this decision asks. Never a completion requirement. */
      reviewPasses: GateBriefReviewPass[];
      machine: {
        approvalId: string;
        caseId: string;
        pipelineKey: string;
        stepKey: string;
        workVersion: number;
      };
    };

// ---------------------------------------------------------------------------
// Small shared shapers
// ---------------------------------------------------------------------------

function quote(text: string, max = 240): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

/** "3 hours", "6 days", "a moment". Null when either stamp is unreadable. */
export function elapsedPhrase(from: string | null, to: string): string | null {
  if (!from) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const minutes = Math.floor((end - start) / 60_000);
  if (minutes < 2) return "a moment";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "a day" : `${days} days`;
}

/** "12 minutes ago". Null when the stamp is unreadable. */
function agoPhrase(at: string | null, now: string): string | null {
  const phrase = elapsedPhrase(at, now);
  if (!phrase) return null;
  return phrase === "a moment" ? "just now" : `${phrase} ago`;
}

/** A human name for the ticket's kind ("feature", "design-change" → "design change"). */
function ticketKindPhrase(ticketType: string | null): string | null {
  if (!ticketType) return null;
  const words = ticketType.replace(/[-_]+/g, " ").trim();
  return words.length > 0 ? words : null;
}

// ---------------------------------------------------------------------------
// 1 — what is being decided
// ---------------------------------------------------------------------------

/**
 * Where each answer sends the work, in the pipeline's OWN names.
 *
 * The precedent is the item page's "Approve · Move to Spec" button: a person
 * who has to guess where "approve" leads is not making an informed decision.
 * "Send it back" is offered only when there genuinely is an earlier step to
 * send it to — promising a rerun that never happens is worse than saying it
 * is not available here.
 */
export function describeOutcomes(decision: GateBriefFacts["decision"]): GateBriefOutcome[] {
  const outcomes: GateBriefOutcome[] = [];
  outcomes.push({
    decision: "approve",
    line: decision.approveToStepName
      ? `Approve — this moves on to ${decision.approveToStepName}.`
      : "Approve — this moves on to the next step.",
  });
  if (decision.requestChangesToStepName) {
    outcomes.push({
      decision: "request_changes",
      line:
        `Send it back — ${decision.requestChangesToStepName} runs again with your reason, ` +
        "and this decision comes round again on the new work. A reason is required.",
    });
  }
  outcomes.push({
    decision: "reject",
    line: decision.rejectToStepName
      ? `Stop it here — this moves to ${decision.rejectToStepName} and nothing further runs. A reason is required.`
      : "Stop it here — nothing further runs. A reason is required.",
  });
  return outcomes;
}

/**
 * The one line at the top: what happened, and what your answer moves.
 *
 * Deliberately different for an entry decision. "Nothing has been built yet"
 * is the single most decision-relevant fact about a Promote gate, and a brief
 * that opened with the same sentence it uses after an agent wrote a spec
 * would be telling the reader nothing.
 */
function decidingHeadline(facts: GateBriefFacts): string {
  const onward = facts.decision.approveToStepName
    ? `whether it goes on to ${facts.decision.approveToStepName}`
    : "whether it goes any further";
  if (!facts.upstream) {
    return `Nothing has been built yet — this is the first decision on this work. You are deciding ${onward}.`;
  }
  const who = facts.upstream.actorName ?? (facts.upstream.kind === "agent" ? "An agent" : "The last step");
  const finished = agoPhrase(facts.upstream.finishedAt, facts.now);
  const when = finished ? ` ${finished}` : "";
  return `${who} finished ${facts.upstream.stepName}${when}. You are deciding ${onward}.`;
}

function waitingLine(facts: GateBriefFacts): string | null {
  const waited = elapsedPhrase(facts.decision.openedAt, facts.now);
  if (!waited) return null;
  if (waited === "a moment") return "This has just started waiting for you.";
  return `This has been waiting ${waited} for your decision.`;
}

// ---------------------------------------------------------------------------
// 2 — what the previous step produced
// ---------------------------------------------------------------------------

/**
 * The ticket itself, as the artifact.
 *
 * An entry decision has no upstream step, so rendering an empty "what was
 * produced" section would be both blank and wrong: something IS being judged,
 * it is just the request rather than a response to it. So the ticket body,
 * its acceptance criteria and the two facts that decide whether the work can
 * even start (what kind of work it is, and which codebase it lands in) are
 * laid out as the artifact. This case is designed, not defaulted into.
 */
function ticketAsArtifact(ticket: GateBriefTicketFacts): GateBriefLookAtItem[] {
  const items: GateBriefLookAtItem[] = [];
  const description = ticket.description?.trim() ?? "";
  const kind = ticketKindPhrase(ticket.ticketType);
  const meta = [
    kind ? `Asked for as a ${kind}` : null,
    ticket.codebase ? `lands in ${ticket.codebase}` : "no codebase named yet",
  ]
    .filter((part): part is string => !!part)
    .join(" · ");

  items.push({
    label: "What was asked for",
    excerpt: description.length > 0 ? description : null,
    truncated: false,
    anchor: null,
    url: null,
    meta,
  });
  if (ticket.acceptanceSection) {
    items.push({
      label: "What would make it done",
      excerpt: ticket.acceptanceSection,
      truncated: false,
      anchor: null,
      url: null,
      meta: null,
    });
  }
  return items;
}

function upstreamArtifacts(upstream: GateBriefUpstreamFacts, now: string): GateBriefLookAtItem[] {
  const items: GateBriefLookAtItem[] = [];
  for (const document of upstream.documents) {
    const wrote = upstream.actorName ? `Written by ${upstream.actorName}` : "Written by the step";
    const when = agoPhrase(document.updatedAt, now);
    items.push({
      label: document.title?.trim() || document.key,
      excerpt: document.excerpt,
      truncated: document.truncated,
      anchor: document.key,
      url: null,
      meta: when ? `${wrote}, ${when}` : wrote,
    });
  }
  if (upstream.pullRequest) {
    const pr = upstream.pullRequest;
    items.push({
      label: "The proposed change",
      excerpt: null,
      truncated: false,
      anchor: null,
      url: pr.url,
      meta: `${pr.repo} · ${pr.head}`,
    });
  }
  if (upstream.closingNote) {
    const when = agoPhrase(upstream.closingNote.at, now);
    items.push({
      label: "What it said when it finished",
      excerpt: upstream.closingNote.excerpt,
      truncated: upstream.closingNote.truncated,
      anchor: null,
      url: null,
      meta: when,
    });
  }
  return items;
}

/**
 * Section 2, whole.
 *
 * The honest-absence rule lives here: a step that finished and left nothing
 * gets a sentence saying exactly that, naming the step, because "the agent
 * step completed but left no document" is itself decision-relevant — it is
 * the difference between approving work and approving a claim.
 */
function assembleLookAt(facts: GateBriefFacts): NonNullable<
  Extract<PipelineGateBrief, { available: true }>
>["lookAt"] {
  if (!facts.upstream) {
    const items = facts.ticket ? ticketAsArtifact(facts.ticket) : [];
    if (items.length === 0) {
      return {
        headline: "There is nothing to read before this decision.",
        items: [],
        nothingThere:
          "No earlier step has run and the ticket itself could not be read, so there is no written record of what is being asked for. Worth finding out why before you approve.",
      };
    }
    return {
      headline: "Nothing has been produced yet, so what you are judging is the request itself.",
      items,
      nothingThere: facts.ticket?.description?.trim()
        ? null
        : "The ticket has no description, so all you have to go on is its title.",
    };
  }

  const items = upstreamArtifacts(facts.upstream, facts.now);
  if (items.length === 0) {
    const ran = facts.upstream.ranWhat ? ` (${facts.upstream.ranWhat})` : "";
    return {
      headline: `${facts.upstream.stepName} finished and left nothing to read.`,
      items: [],
      nothingThere:
        `${facts.upstream.stepName}${ran} completed, but it wrote no document, opened no change and left no note. ` +
        "There is no record of what it did, so approving here means approving a claim rather than work you have seen.",
    };
  }
  const noun = items.length === 1 ? "this" : `these ${items.length} things`;
  return {
    headline: `${facts.upstream.stepName} produced ${noun}.`,
    items,
    nothingThere: null,
  };
}

// ---------------------------------------------------------------------------
// 3 — what was already checked
// ---------------------------------------------------------------------------

/**
 * The acceptance verdict, translated, and labelled as machine-checked.
 *
 * Three honest states, and the third is the one that matters: a verdict
 * recorded against an older version of the work is evidence about something
 * else. Reporting it as a pass would be the exact "reports green having
 * checked nothing" failure the acceptance grammar exists to refuse.
 */
export function describeChecked(
  acceptance: GateBriefAcceptanceFacts | null,
  upstreamName: string | null,
): Extract<PipelineGateBrief, { available: true }>["checked"] {
  if (!acceptance) {
    return {
      headline: "Nothing here was checked automatically.",
      ok: null,
      detail: upstreamName
        ? `${upstreamName} declared no check the machine could run, so everything below is your judgement.`
        : "No automatic check applies before this decision, so everything below is your judgement.",
      machine: [],
    };
  }
  const machine = [acceptance.criteria, acceptance.evaluation].filter(
    (value): value is string => !!value && value.trim().length > 0,
  );
  if (!acceptance.coversCurrentWork) {
    return {
      headline: "The automatic check does not cover what you are looking at.",
      ok: null,
      detail:
        "It ran against an earlier version of this work, which has changed since. Treat it as saying nothing about the version in front of you.",
      machine,
    };
  }
  if (!acceptance.ok) {
    return {
      headline: "The automatic check did NOT pass.",
      ok: false,
      detail: acceptance.message?.trim()
        ? acceptance.message.trim()
        : "The machine looked for what the step promised to produce and did not find it. Approving means approving over a failed check.",
      machine,
    };
  }
  return {
    headline: "Checked by the machine, and it passed.",
    ok: true,
    detail: upstreamName
      ? `${upstreamName} produced what it promised to produce. That is all this check says — whether it is any good is what you are here for.`
      : "The step produced what it promised to produce. Whether it is any good is what you are here for.",
    machine,
  };
}

// ---------------------------------------------------------------------------
// 4 — history that changes the decision
// ---------------------------------------------------------------------------

/**
 * Only history that could change the answer.
 *
 * Not an activity feed. A round already spent here says the reviewer has
 * seen this before and asked for something — showing what they asked for is
 * how the second look is a follow-up rather than a fresh read. Decisions
 * already taken elsewhere say which parts are settled.
 */
export function describeHistory(facts: GateBriefFacts): string[] {
  const lines: string[] = [];
  const rounds = facts.rounds;
  if (rounds.length > 0) {
    const last = rounds[rounds.length - 1]!;
    const when = agoPhrase(last.at, facts.now);
    const times = rounds.length === 1 ? "once" : `${rounds.length} times`;
    lines.push(
      `You have sent this back ${times} already${when ? `, most recently ${when}` : ""}. ` +
        "This is a second look, not a first one.",
    );
    if (last.askedFor) {
      lines.push(`Last time you asked for: “${quote(last.askedFor)}”`);
    } else {
      lines.push("No reason was recorded on that last send-back, so there is nothing to check the new work against.");
    }
  }
  for (const prior of facts.priorDecisions) {
    const when = agoPhrase(prior.at, facts.now);
    const verb =
      prior.decision === "approve" ? "approved" : prior.decision === "reject" ? "stopped" : "sent back";
    lines.push(`You ${verb} ${prior.stepName}${when ? ` ${when}` : ""}.`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 5 — review passes
// ---------------------------------------------------------------------------

/**
 * The questions this decision asks, resolved from the catalogue.
 *
 * Questions, never checkboxes that block: a forced tick becomes a reflex and
 * teaches people to lie (docs/architecture/review-passes.md). An id with no
 * catalogue entry is skipped rather than invented — the cockpit displays this
 * doctrine, it does not author it.
 */
export function collectGateReviewPasses(ids: string[]): GateBriefReviewPass[] {
  const catalog: Record<string, ReviewPass> = reviewPassCatalogFor(ids);
  const passes: GateBriefReviewPass[] = [];
  for (const id of ids) {
    const entry = catalog[id];
    if (!entry) continue;
    passes.push({ id: entry.id, label: entry.label, question: entry.question });
  }
  return passes;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the brief. Pure, synchronous, and free of I/O by construction —
 * see the module header for why that is a property worth protecting.
 */
export function assembleGateBrief(facts: GateBriefFacts): PipelineGateBrief {
  const subject = facts.ticket?.title?.trim() || "this work";
  return {
    available: true,
    kind: "pipeline_gate",
    deciding: {
      headline: decidingHeadline(facts),
      question: facts.decision.question?.trim() || null,
      subject,
      ticketIdentifier: facts.ticket?.identifier ?? null,
      ticketId: facts.ticket?.id ?? null,
      outcomes: describeOutcomes(facts.decision),
      waitingFor: waitingLine(facts),
    },
    lookAt: assembleLookAt(facts),
    checked: describeChecked(facts.acceptance, facts.upstream?.stepName ?? null),
    history: describeHistory(facts),
    reviewPasses: collectGateReviewPasses(facts.decision.reviewPassIds),
    machine: {
      approvalId: facts.approvalId,
      caseId: facts.caseId,
      pipelineKey: facts.pipeline.key,
      stepKey: facts.decision.stepKey,
      workVersion: facts.workVersion,
    },
  };
}
