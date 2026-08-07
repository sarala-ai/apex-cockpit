/**
 * The gate decision brief, asserted on CONTENT.
 *
 * These tests read the rendered sentences, not the shape, because the shape
 * was never the problem: the gate always had a payload, and it still read as
 * "Gate 1: Promote — is it worth doing. Seconds." A brief that returns the
 * right keys and says nothing useful is exactly the failure being fixed, and
 * only assertions on the words can catch that.
 *
 * Four shapes, matching the four ways a real gate arrives:
 *   (a) an upstream agent step that produced a document
 *   (b) an entry decision with no upstream step at all (Feature's Promote)
 *   (c) a decision re-entered after changes were asked for
 *   (d) an upstream step that finished and left nothing
 * plus the vocabulary guard, which is a test about respect rather than
 * correctness: a person deciding must never be handed our field names.
 */
import { describe, expect, it } from "vitest";
import {
  assembleGateBrief,
  elapsedPhrase,
  type GateBriefFacts,
} from "../apex/steps/gate-brief.js";
import { acceptanceSectionOf } from "../apex/pipeline/gate-brief-facts.js";

const NOW = "2026-08-07T12:00:00.000Z";

function facts(overrides: Partial<GateBriefFacts> = {}): GateBriefFacts {
  return {
    approvalId: "approval-1",
    caseId: "case-1",
    workVersion: 4,
    pipeline: { key: "feature", name: "Feature" },
    decision: {
      stepKey: "spec_design_gate",
      stepName: "Spec Design Gate",
      question:
        "Gate 2: Spec approval — the load-bearing gate. Approving pre-approves all derived tasks, explicitly.",
      reviewPassIds: ["customer_hat", "reversibility"],
      approveToStepName: "Tasks",
      rejectToStepName: "Cancelled",
      requestChangesToStepName: "Spec",
      openedAt: "2026-08-07T09:00:00.000Z",
    },
    ticket: {
      id: "issue-1",
      identifier: "APEX-14",
      title: "Gate briefs hand over the artifact, not a label",
      description: "The gate shows a seed-time prompt and nothing else.\n\n## Acceptance Criteria\n- The brief names the upstream step",
      acceptanceSection: "- The brief names the upstream step",
      ticketType: "feature",
      codebase: "sarala-ai/cockpit",
    },
    upstream: {
      stepKey: "spec",
      stepName: "Spec",
      kind: "agent",
      actorName: "Specifier",
      finishedAt: "2026-08-07T08:40:00.000Z",
      documents: [
        {
          key: "spec",
          title: "Spec",
          excerpt: "# Spec\n\n## Task 1 — assemble the brief\nAcceptance: the route returns the upstream document.",
          truncated: true,
          updatedAt: "2026-08-07T08:39:00.000Z",
        },
      ],
      pullRequest: null,
      closingNote: null,
      ranWhat: null,
    },
    acceptance: {
      criteria: "file_exists:specs/gate-brief.md",
      ok: true,
      message: null,
      evaluation: "v1: run success + file_exists verified",
      coversCurrentWork: true,
      evaluatedAt: "2026-08-07T08:41:00.000Z",
    },
    rounds: [],
    priorDecisions: [],
    now: NOW,
    ...overrides,
  };
}

function assemble(overrides: Partial<GateBriefFacts> = {}) {
  const brief = assembleGateBrief(facts(overrides));
  if (brief.available === false) throw new Error(`brief unavailable: ${brief.reason}`);
  return brief;
}

/** Every sentence a person actually reads, flattened — the surface the
 *  vocabulary guard scans and the shape tests search. */
function readableText(brief: ReturnType<typeof assemble>): string {
  return [
    brief.deciding.headline,
    brief.deciding.question,
    brief.deciding.subject,
    brief.deciding.waitingFor,
    ...brief.deciding.outcomes.map((outcome) => outcome.line),
    brief.lookAt.headline,
    brief.lookAt.nothingThere,
    ...brief.lookAt.items.flatMap((item) => [item.label, item.meta, item.excerpt]),
    brief.checked.headline,
    brief.checked.detail,
    ...brief.history,
    ...brief.reviewPasses.flatMap((pass) => [pass.label, pass.question]),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

describe("gate brief — (a) an upstream agent step that produced a document", () => {
  it("names who finished what, and where approving sends it", () => {
    const brief = assemble();

    expect(brief.deciding.headline).toBe(
      "Specifier finished Spec 3 hours ago. You are deciding whether it goes on to Tasks.",
    );
    expect(brief.deciding.subject).toBe("Gate briefs hand over the artifact, not a label");
    expect(brief.deciding.ticketIdentifier).toBe("APEX-14");
    expect(brief.deciding.waitingFor).toBe("This has been waiting 3 hours for your decision.");
  });

  it("offers all three outcomes in the pipeline's own names for its steps", () => {
    const lines = assemble().deciding.outcomes;

    expect(lines.map((outcome) => outcome.decision)).toEqual(["approve", "request_changes", "reject"]);
    expect(lines[0]!.line).toBe("Approve — this moves on to Tasks.");
    expect(lines[1]!.line).toContain("Spec runs again with your reason");
    expect(lines[2]!.line).toContain("this moves to Cancelled and nothing further runs");
  });

  it("hands over the document itself, with an honest cut and a way to the whole thing", () => {
    const brief = assemble();

    expect(brief.lookAt.headline).toBe("Spec produced this.");
    expect(brief.lookAt.nothingThere).toBeNull();
    const item = brief.lookAt.items[0]!;
    expect(item.label).toBe("Spec");
    expect(item.excerpt).toContain("## Task 1 — assemble the brief");
    expect(item.truncated).toBe(true);
    // One click away at most: the anchor is the document's own key on the
    // ticket page, so "read the rest" never means "go and find it".
    expect(item.anchor).toBe("spec");
    expect(item.meta).toBe("Written by Specifier, 3 hours ago");
  });

  it("labels the machine check as a machine check, and says what it does NOT cover", () => {
    const brief = assemble();

    expect(brief.checked.ok).toBe(true);
    expect(brief.checked.headline).toBe("Checked by the machine, and it passed.");
    expect(brief.checked.detail).toContain("whether it is any good is what you are here for");
    // The raw strings travel, but never as the headline.
    expect(brief.checked.machine).toEqual([
      "file_exists:specs/gate-brief.md",
      "v1: run success + file_exists verified",
    ]);
    expect(brief.checked.headline).not.toContain("file_exists");
  });

  it("refuses to report a verdict about an earlier version of the work as a pass", () => {
    const brief = assemble({
      acceptance: { ...facts().acceptance!, coversCurrentWork: false },
    });

    expect(brief.checked.ok).toBeNull();
    expect(brief.checked.headline).toBe("The automatic check does not cover what you are looking at.");
    expect(brief.checked.detail).toContain("ran against an earlier version");
  });

  it("carries the gate's declared review passes as questions, with the catalogue's wording", () => {
    const passes = assemble().reviewPasses;

    expect(passes.map((pass) => pass.id)).toEqual(["customer_hat", "reversibility"]);
    expect(passes[0]!.question).toBe(
      "Would a first-time user understand this screen without knowing how it was built?",
    );
  });

  it("links the pull request a step was required to open, without inventing a URL", () => {
    const brief = assemble({
      upstream: {
        ...facts().upstream!,
        documents: [],
        pullRequest: { repo: "sarala-ai/apex-design", head: "design/APEX-14", url: null },
      },
    });

    const item = brief.lookAt.items[0]!;
    expect(item.label).toBe("The proposed change");
    expect(item.url).toBeNull();
    expect(item.meta).toBe("sarala-ai/apex-design · design/APEX-14");
  });
});

describe("gate brief — (b) an entry decision with no upstream step (Feature's Promote)", () => {
  const promote = (): Partial<GateBriefFacts> => ({
    decision: {
      stepKey: "promote",
      stepName: "Promote",
      question: "Gate 1: Promote — is it worth doing. Seconds.",
      reviewPassIds: [],
      approveToStepName: "Spec",
      rejectToStepName: "Cancelled",
      // Nothing precedes Promote, so there is no step to send it back to.
      requestChangesToStepName: null,
      openedAt: "2026-08-07T11:50:00.000Z",
    },
    upstream: null,
    acceptance: null,
  });

  it("says out loud that nothing has been built yet, rather than rendering an empty section", () => {
    const brief = assemble(promote());

    expect(brief.deciding.headline).toBe(
      "Nothing has been built yet — this is the first decision on this work. You are deciding whether it goes on to Spec.",
    );
    expect(brief.lookAt.headline).toBe(
      "Nothing has been produced yet, so what you are judging is the request itself.",
    );
    expect(brief.lookAt.nothingThere).toBeNull();
  });

  it("makes the ticket itself the artifact: the ask, what would make it done, type and codebase", () => {
    const brief = assemble(promote());

    expect(brief.lookAt.items.map((item) => item.label)).toEqual([
      "What was asked for",
      "What would make it done",
    ]);
    expect(brief.lookAt.items[0]!.excerpt).toContain("The gate shows a seed-time prompt");
    expect(brief.lookAt.items[0]!.meta).toBe("Asked for as a feature · lands in sarala-ai/cockpit");
    expect(brief.lookAt.items[1]!.excerpt).toBe("- The brief names the upstream step");
  });

  it("does not offer to send back work that no earlier step could redo", () => {
    const outcomes = assemble(promote()).deciding.outcomes;

    expect(outcomes.map((outcome) => outcome.decision)).toEqual(["approve", "reject"]);
  });

  it("says there is no automatic check rather than implying one passed", () => {
    const brief = assemble(promote());

    expect(brief.checked.ok).toBeNull();
    expect(brief.checked.headline).toBe("Nothing here was checked automatically.");
    expect(brief.checked.detail).toContain("everything below is your judgement");
  });

  it("states a missing description instead of leaving the reader with a blank", () => {
    const brief = assemble({
      ...promote(),
      ticket: { ...facts().ticket!, description: null, acceptanceSection: null },
    });

    expect(brief.lookAt.items[0]!.excerpt).toBeNull();
    expect(brief.lookAt.nothingThere).toBe(
      "The ticket has no description, so all you have to go on is its title.",
    );
  });

  it("names the missing codebase rather than quietly omitting it", () => {
    const brief = assemble({
      ...promote(),
      ticket: { ...facts().ticket!, codebase: null },
    });

    expect(brief.lookAt.items[0]!.meta).toBe("Asked for as a feature · no codebase named yet");
  });

  /** The exact copy a founder sees on the first gate a real ticket hits. */
  it("reads, end to end, as a decision a person can take", () => {
    const brief = assemble(promote());

    expect(readableText(brief)).toBe(
      [
        "Nothing has been built yet — this is the first decision on this work. You are deciding whether it goes on to Spec.",
        "Gate 1: Promote — is it worth doing. Seconds.",
        "Gate briefs hand over the artifact, not a label",
        "This has been waiting 10 minutes for your decision.",
        "Approve — this moves on to Spec.",
        "Stop it here — this moves to Cancelled and nothing further runs. A reason is required.",
        "Nothing has been produced yet, so what you are judging is the request itself.",
        "What was asked for",
        "Asked for as a feature · lands in sarala-ai/cockpit",
        "The gate shows a seed-time prompt and nothing else.\n\n## Acceptance Criteria\n- The brief names the upstream step",
        "What would make it done",
        "- The brief names the upstream step",
        "Nothing here was checked automatically.",
        "No automatic check applies before this decision, so everything below is your judgement.",
      ].join("\n"),
    );
  });
});

describe("gate brief — (c) a decision re-entered after changes were asked for", () => {
  it("says this is a second look and quotes what was asked for last time", () => {
    const brief = assemble({
      rounds: [
        { round: 1, askedFor: "Split task 3 — it is two PRs.", at: "2026-08-05T12:00:00.000Z" },
        { round: 2, askedFor: "The acceptance for task 1 is not machine-checkable.", at: "2026-08-07T09:00:00.000Z" },
      ],
    });

    expect(brief.history[0]).toBe(
      "You have sent this back 2 times already, most recently 3 hours ago. This is a second look, not a first one.",
    );
    expect(brief.history[1]).toBe(
      "Last time you asked for: “The acceptance for task 1 is not machine-checkable.”",
    );
  });

  it("counts a single round as once", () => {
    const brief = assemble({
      rounds: [{ round: 1, askedFor: "Narrow the scope.", at: "2026-08-06T12:00:00.000Z" }],
    });

    expect(brief.history[0]).toContain("You have sent this back once already, most recently a day ago.");
  });

  it("flags a send-back that recorded no reason, because the new work cannot be checked against it", () => {
    const brief = assemble({
      rounds: [{ round: 1, askedFor: null, at: "2026-08-07T09:00:00.000Z" }],
    });

    expect(brief.history[1]).toBe(
      "No reason was recorded on that last send-back, so there is nothing to check the new work against.",
    );
  });

  it("carries decisions already taken elsewhere on this work", () => {
    const brief = assemble({
      priorDecisions: [
        { stepName: "Promote", decision: "approve", at: "2026-08-05T12:00:00.000Z" },
      ],
    });

    expect(brief.history).toContain("You approved Promote 2 days ago.");
  });

  it("says nothing at all when nothing in the history would change the answer", () => {
    expect(assemble().history).toEqual([]);
  });
});

describe("gate brief — (d) an upstream step that produced nothing", () => {
  const producedNothing = (): Partial<GateBriefFacts> => ({
    upstream: {
      ...facts().upstream!,
      documents: [],
      pullRequest: null,
      closingNote: null,
    },
    acceptance: null,
  });

  it("states the absence as the decision-relevant fact it is", () => {
    const brief = assemble(producedNothing());

    expect(brief.lookAt.headline).toBe("Spec finished and left nothing to read.");
    expect(brief.lookAt.items).toEqual([]);
    expect(brief.lookAt.nothingThere).toBe(
      "Spec completed, but it wrote no document, opened no change and left no note. " +
        "There is no record of what it did, so approving here means approving a claim rather than work you have seen.",
    );
  });

  it("names what a machine step ran, so the reader knows what produced the state", () => {
    const brief = assemble({
      upstream: {
        ...facts().upstream!,
        stepKey: "deploy",
        stepName: "Deploy",
        kind: "run",
        actorName: null,
        documents: [],
        closingNote: null,
        ranWhat: "cloud_run_deploy",
      },
      acceptance: null,
    });

    expect(brief.deciding.headline).toContain("The last step finished Deploy");
    expect(brief.lookAt.nothingThere).toContain("Deploy (cloud_run_deploy) completed");
  });
});

describe("gate brief — the words a person reads", () => {
  /** Our field names, our table names, our event names. None of them belong
   *  in front of somebody being asked to make a judgement. */
  const INTERNAL_VOCABULARY = [
    /\bcase\b/i,
    /\bcaseId\b/i,
    /\bstage config\b/i,
    /\bonEnter\b/i,
    /\bstageKey\b/i,
    /\bnodeId\b/i,
    /\bstepKey\b/i,
    /\bpipeline_gate\b/i,
    /\bflow_gate\b/i,
    /\bterminalKind\b/i,
    /\bacceptance_evaluated\b/i,
    /\bstep_waiting\b/i,
    /\bgate_opened\b/i,
    /\breview_decided\b/i,
    /\bpayload\b/i,
    /\bapprovalId\b/i,
    // A bare UUID in a sentence a person reads is always a leak.
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i,
  ];

  const SHAPES: Array<[string, Partial<GateBriefFacts>]> = [
    ["an upstream step with a document", {}],
    [
      "an entry decision",
      {
        decision: {
          stepKey: "promote",
          stepName: "Promote",
          question: "Gate 1: Promote — is it worth doing. Seconds.",
          reviewPassIds: [],
          approveToStepName: "Spec",
          rejectToStepName: "Cancelled",
          requestChangesToStepName: null,
          openedAt: "2026-08-07T11:00:00.000Z",
        },
        upstream: null,
        acceptance: null,
      },
    ],
    [
      "a re-entered decision",
      { rounds: [{ round: 1, askedFor: "Do it again.", at: "2026-08-06T12:00:00.000Z" }] },
    ],
    [
      "a step that produced nothing",
      { upstream: { ...facts().upstream!, documents: [], closingNote: null }, acceptance: null },
    ],
    [
      "a failed check",
      {
        acceptance: {
          criteria: "pr_exists:sarala-ai/cockpit#feat/x",
          ok: false,
          message: "no pull request was found on that branch",
          evaluation: "v1: pr_exists check FAILED",
          coversCurrentWork: true,
          evaluatedAt: "2026-08-07T08:41:00.000Z",
        },
      },
    ],
  ];

  for (const [name, overrides] of SHAPES) {
    it(`leaks no internal vocabulary for ${name}`, () => {
      const text = readableText(assemble(overrides));
      for (const pattern of INTERNAL_VOCABULARY) {
        expect(text, `"${pattern}" leaked into: ${text}`).not.toMatch(pattern);
      }
    });
  }

  it("keeps the raw machine strings, but only under the details affordance", () => {
    const brief = assemble({
      acceptance: {
        criteria: "pr_exists:sarala-ai/cockpit#feat/x",
        ok: false,
        message: "no pull request was found on that branch",
        evaluation: "v1: pr_exists check FAILED",
        coversCurrentWork: true,
        evaluatedAt: "2026-08-07T08:41:00.000Z",
      },
    });

    expect(brief.checked.headline).toBe("The automatic check did NOT pass.");
    expect(brief.checked.detail).toBe("no pull request was found on that branch");
    expect(brief.checked.machine).toContain("pr_exists:sarala-ai/cockpit#feat/x");
    expect(brief.checked.headline).not.toContain("pr_exists");
  });

  it("quotes a long send-back reason without running the section off the page", () => {
    const brief = assemble({
      rounds: [{ round: 1, askedFor: "x".repeat(400), at: "2026-08-07T09:00:00.000Z" }],
    });

    expect(brief.history[1]!.length).toBeLessThan(300);
    expect(brief.history[1]).toContain("…");
  });
});

describe("gate brief — supporting readers", () => {
  it("phrases elapsed time the way a person says it", () => {
    expect(elapsedPhrase("2026-08-07T11:59:30.000Z", NOW)).toBe("a moment");
    expect(elapsedPhrase("2026-08-07T11:30:00.000Z", NOW)).toBe("30 minutes");
    expect(elapsedPhrase("2026-08-07T11:00:00.000Z", NOW)).toBe("an hour");
    expect(elapsedPhrase("2026-08-06T12:00:00.000Z", NOW)).toBe("a day");
    expect(elapsedPhrase("2026-08-01T12:00:00.000Z", NOW)).toBe("6 days");
    expect(elapsedPhrase(null, NOW)).toBeNull();
    expect(elapsedPhrase("not a date", NOW)).toBeNull();
  });

  it("pulls the acceptance section out of a ticket body, whatever it is headed", () => {
    expect(acceptanceSectionOf("## Acceptance Criteria\n- one\n- two\n\n## Notes\nignore")).toBe(
      "- one\n- two",
    );
    expect(acceptanceSectionOf("### Acceptance\n- only this")).toBe("- only this");
    expect(acceptanceSectionOf("## Notes\nnothing here")).toBeNull();
    expect(acceptanceSectionOf(null)).toBeNull();
  });
});
