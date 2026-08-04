/**
 * What a ticket is allowed to say about the process it is on.
 *
 * The behaviour under test is the one that decides whether a person is shown a
 * decision to make, so the cases that matter are the negatives: a case that is
 * merely working, and a case that ENDED on a review stage. Both must read as
 * "nothing to do here".
 */
import { describe, expect, it } from "vitest";
import {
  isAwaitingHumanDecision,
  reviewStageQuestion,
  shapeIssueLinkedCase,
} from "../apex/pipeline/issue-lifecycle.js";

type StageInput = Parameters<typeof shapeIssueLinkedCase>[0]["stage"];

function stage(overrides: Partial<StageInput> = {}): StageInput {
  return {
    id: "stage-1",
    pipelineId: "pipeline-1",
    key: "promote",
    name: "Promote",
    kind: "review",
    position: 100,
    config: {
      gate: { mode: "approve", prompt: "Gate 1: Promote — is it worth doing. Seconds.", requires: null },
      approver: { kind: "any_human" },
      requireApproval: true,
      approveToStageKey: "spec",
      rejectToStageKey: "cancelled",
      requireRejectReason: true,
      requireRequestChangesReason: true,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as StageInput;
}

function row(overrides: {
  stage?: StageInput;
  terminalKind?: string | null;
  role?: string;
  version?: number;
} = {}) {
  return {
    link: { role: overrides.role ?? "work" } as { role: string },
    case: {
      id: "case-1",
      caseKey: "ticket:issue-1",
      title: "Render a ticket's type",
      terminalKind: overrides.terminalKind ?? null,
      version: overrides.version ?? 1,
    },
    pipeline: { id: "pipeline-1", key: "feature", name: "Feature" },
    stage: overrides.stage ?? stage(),
  } as Parameters<typeof shapeIssueLinkedCase>[0];
}

describe("a ticket parked at a human gate", () => {
  it("carries the decision, the gate's own question, and the version needed to submit it", () => {
    const shaped = shapeIssueLinkedCase(row());

    expect(shaped.review).not.toBeNull();
    expect(shaped.review!.question).toBe("Gate 1: Promote — is it worth doing. Seconds.");
    // Without the version the ticket could render a decision it cannot submit:
    // the review endpoint's optimistic-concurrency check would reject it.
    expect(shaped.version).toBe(1);
    expect(shaped.stage.name).toBe("Promote");
    expect(shaped.pipeline.name).toBe("Feature");
  });

  it("offers only the decisions the stage itself declares", () => {
    const shaped = shapeIssueLinkedCase(row());
    const config = shaped.review!.config;

    expect(config.approveToStageKey).toBe("spec");
    expect(config.rejectToStageKey).toBe("cancelled");
    // This gate declares no request-changes target, so there is genuinely no
    // such decision — rendering the button would offer one the server refuses.
    expect(config.requestChangesToStageKey).toBeUndefined();
  });

  it("says nothing rather than inventing a question when the gate declared none", () => {
    const shaped = shapeIssueLinkedCase(
      row({
        stage: stage({
          config: {
            approver: { kind: "any_human" },
            requireApproval: true,
            approveToStageKey: "spec",
            rejectToStageKey: "cancelled",
          },
        }),
      }),
    );

    expect(shaped.review).not.toBeNull();
    expect(shaped.review!.question).toBeNull();
  });

  it("still reports the pending decision when the stage config is too broken to derive actions from", () => {
    // A review stage missing its approve target fails the pipeline editor's
    // validator. That must not 500 the whole issue detail, and it must not
    // silently drop the decision either — the ticket keeps saying someone is
    // waited on, and links out to where it can be decided.
    const shaped = shapeIssueLinkedCase(
      row({ stage: stage({ config: { gate: { prompt: "Worth doing?" } } }) }),
    );

    expect(shaped.review).not.toBeNull();
    expect(shaped.review!.question).toBe("Worth doing?");
    expect(shaped.review!.config).toEqual({});
  });
});

describe("a ticket with nothing outstanding", () => {
  it("reports no decision while the process is working", () => {
    const shaped = shapeIssueLinkedCase(
      row({ stage: stage({ key: "spec", name: "Spec", kind: "working", config: {} }) }),
    );

    expect(shaped.review).toBeNull();
    expect(shaped.stage.name).toBe("Spec");
    expect(shaped.status).toBe("open");
  });

  it("reports no decision for a case that FINISHED on a review stage", () => {
    // The case ended while sitting at a gate. That is history, not a request:
    // showing it as pending would put a decision on the ticket that nobody
    // can make and no endpoint would accept.
    const shaped = shapeIssueLinkedCase(row({ terminalKind: "done" }));

    expect(shaped.review).toBeNull();
    expect(shaped.status).toBe("done");
    expect(shaped.terminalKind).toBe("done");
  });

  it("decides pending-ness from the stage kind and terminal state together", () => {
    expect(isAwaitingHumanDecision({ terminalKind: null }, { kind: "review" })).toBe(true);
    expect(isAwaitingHumanDecision({ terminalKind: null }, { kind: "working" })).toBe(false);
    expect(isAwaitingHumanDecision({ terminalKind: "cancelled" }, { kind: "review" })).toBe(false);
  });
});

describe("the gate question is read from the stage, defensively", () => {
  it("ignores a config with no gate, a non-object gate, and a blank prompt", () => {
    expect(reviewStageQuestion({ config: null })).toBeNull();
    expect(reviewStageQuestion({ config: {} })).toBeNull();
    expect(reviewStageQuestion({ config: { gate: "approve" } })).toBeNull();
    expect(reviewStageQuestion({ config: { gate: ["approve"] } })).toBeNull();
    expect(reviewStageQuestion({ config: { gate: { prompt: "   " } } })).toBeNull();
    expect(reviewStageQuestion({ config: { gate: { prompt: "  Ship it?  " } } })).toBe("Ship it?");
  });
});

describe("the link role is carried through untouched", () => {
  it("keeps roles distinguishable so a bystander case is not read as the ticket's work", () => {
    expect(shapeIssueLinkedCase(row({ role: "work" })).role).toBe("work");
    expect(shapeIssueLinkedCase(row({ role: "conversation" })).role).toBe("conversation");
  });
});
