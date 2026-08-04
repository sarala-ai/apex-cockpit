// @vitest-environment jsdom

/**
 * What a person sees on a ticket about its lifecycle.
 *
 * The behaviour worth protecting is the loud one: when a process has stopped
 * to ask a human something, the ticket must say so unmissably, in the words
 * the process itself used, and offer exactly the decisions that stage declares
 * — no more (a button the server refuses) and no fewer (a decision the person
 * has to go hunting for a board to make).
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueLinkedCase } from "@paperclipai/shared";

vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { IssueLifecycle } from "./IssueLifecycle";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let root: any;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const GATE_CONFIG = {
  gate: { mode: "approve", prompt: "Gate 1: Promote — is it worth doing. Seconds." },
  approver: { kind: "any_human" },
  requireApproval: true,
  approveToStageKey: "spec",
  rejectToStageKey: "cancelled",
  requireRejectReason: true,
  requireRequestChangesReason: true,
};

/** The pipeline's own names for its stages, as the server sends them. */
const STAGE_NAMES = { spec: "Spec", cancelled: "Cancelled" };

function linkedCase(overrides: Partial<IssueLinkedCase> = {}): IssueLinkedCase {
  return {
    id: "case-1",
    caseKey: "ticket:issue-1",
    title: "Render a ticket's type",
    status: "open",
    role: "work",
    version: 3,
    terminalKind: null,
    pipeline: { id: "pipeline-1", key: "feature", name: "Feature" },
    stage: { id: "stage-1", key: "promote", name: "Promote", kind: "review" },
    review: null,
    hold: null,
    ...overrides,
  };
}

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

function buttonLabels() {
  return [...container.querySelectorAll("button")].map((el) => el.textContent ?? "");
}

describe("a ticket on no process", () => {
  it("renders nothing at all rather than an empty box", () => {
    render(<IssueLifecycle issue={{ linkedCases: [] }} />);
    expect(container.textContent).toBe("");
  });
});

describe("a ticket whose process is working", () => {
  it("says where it has got to, quietly, and links the stage to the board", () => {
    render(
      <IssueLifecycle
        issue={{
          linkedCases: [linkedCase({ stage: { id: "s", key: "spec", name: "Spec", kind: "working" } })],
        }}
      />,
    );

    expect(container.querySelector('[data-testid="issue-lifecycle-position"]')?.textContent)
      .toBe("On the Feature process, now at Spec.");
    expect(container.querySelector('[data-testid="issue-lifecycle-gate"]')).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/pipelines/pipeline-1/items/case-1");
  });
});

describe("a ticket parked at a human gate", () => {
  const parked = {
    linkedCases: [linkedCase({ review: { question: GATE_CONFIG.gate.prompt, config: GATE_CONFIG, stageNames: STAGE_NAMES } })],
  };

  it("states the decision, the question the process asked, and who may answer", () => {
    render(<IssueLifecycle issue={parked} />);
    const gate = container.querySelector('[data-testid="issue-lifecycle-gate"]');

    expect(gate).not.toBeNull();
    expect(gate!.textContent).toContain("Waiting for a decision before this goes any further");
    expect(gate!.textContent).toContain("The Feature process has stopped at Promote.");
    expect(gate!.textContent).toContain("Anyone on the board can decide this.");
    expect(container.querySelector('[data-testid="issue-lifecycle-gate-question"]')?.textContent)
      .toBe("Gate 1: Promote — is it worth doing. Seconds.");
  });

  it("offers exactly the decisions the stage declares, and no others", () => {
    render(<IssueLifecycle issue={parked} onDecide={() => {}} />);

    const labels = buttonLabels();
    expect(labels.some((label) => label.includes("Approve"))).toBe(true);
    expect(labels.some((label) => label.includes("Reject"))).toBe(true);
    // This gate declares no request-changes target, so the decision does not
    // exist; offering it would be offering something the server refuses.
    expect(labels.some((label) => label.includes("Request changes"))).toBe(false);
  });

  it("offers request changes when the stage does declare it", () => {
    render(
      <IssueLifecycle
        issue={{
          linkedCases: [
            linkedCase({
              review: {
                question: null,
                config: { ...GATE_CONFIG, requestChangesToStageKey: "spec" },
                stageNames: STAGE_NAMES,
              },
            }),
          ],
        }}
        onDecide={() => {}}
      />,
    );

    expect(buttonLabels().some((label) => label.includes("Request changes"))).toBe(true);
  });

  it("labels each decision with the pipeline's own name for where it goes", () => {
    render(<IssueLifecycle issue={parked} onDecide={() => {}} />);

    // Not the generic humaniser, which renders the `cancelled` key as
    // "Removed" — a word the board never shows for this stage.
    const labels = buttonLabels();
    expect(labels.some((label) => label.includes("Approve") && label.includes("Spec"))).toBe(true);
    expect(labels.some((label) => label.includes("Reject") && label.includes("Cancelled"))).toBe(true);
    expect(labels.some((label) => label.includes("Removed"))).toBe(false);
  });

  it("submits the decision with the case version the server needs to accept it", () => {
    const onDecide = vi.fn();
    render(<IssueLifecycle issue={parked} onDecide={onDecide} />);

    const approve = [...container.querySelectorAll("button")]
      .find((el) => (el.textContent ?? "").includes("Approve"))!;
    act(() => {
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onDecide).toHaveBeenCalledTimes(1);
    const call = onDecide.mock.calls[0][0];
    expect(call.decision).toBe("approve");
    expect(call.reason).toBeNull();
    expect(call.row.version).toBe(3);
  });

  it("will not let a destructive decision through without the reason the gate demands", () => {
    render(<IssueLifecycle issue={parked} onDecide={() => {}} />);

    const reject = [...container.querySelectorAll("button")]
      .find((el) => (el.textContent ?? "").includes("Reject"))!;
    const approve = [...container.querySelectorAll("button")]
      .find((el) => (el.textContent ?? "").includes("Approve"))!;

    // Approving needs no reason; rejecting does, and the gate says so by
    // refusing rather than by failing after the click.
    expect(reject.hasAttribute("disabled")).toBe(true);
    expect(approve.hasAttribute("disabled")).toBe(false);
  });

  it("still points at the decision when this surface cannot take it", () => {
    // No onDecide: the ticket must not go quiet about a pending decision just
    // because it cannot answer it here.
    render(<IssueLifecycle issue={parked} />);

    expect(container.textContent).toContain("Waiting for a decision");
    expect(container.textContent).toContain("Open the decision");
    expect([...container.querySelectorAll("a")].map((el) => el.getAttribute("href")))
      .toContain("/pipelines/pipeline-1/items/case-1");
  });

  it("keeps saying a decision is pending even when the stage config was too broken to derive buttons", () => {
    render(
      <IssueLifecycle
        issue={{ linkedCases: [linkedCase({ review: { question: "Worth doing?", config: {}, stageNames: {} } })] }}
        onDecide={() => {}}
      />,
    );

    expect(container.textContent).toContain("Waiting for a decision");
    expect(container.textContent).toContain("Worth doing?");
    expect(container.textContent).toContain("Open the decision");
  });
});

/**
 * The regression this closes. The retired flow coordinator posted a
 * plain-language comment on the ticket every time a step paused or failed; the
 * pipeline host that replaced it wrote case events and nothing reached the
 * ticket. A founder watching APEX-14 saw "on the Feature process, now at Spec"
 * about work that had been stopped for hours with a recorded reason.
 */
describe("a ticket whose step has stopped", () => {
  const HOLD = {
    eventId: "event-1",
    stageId: "stage-1",
    stageKey: "spec",
    stageName: "Spec",
    reason: "agent_step_failure",
    errorType: "run_cancelled",
    message: "Cancelled because issue assignee changed before the queued run could start",
    heldAt: "2026-07-27T10:00:00.000Z",
  };

  const held = {
    linkedCases: [linkedCase({
      stage: { id: "stage-1", key: "spec", name: "Spec", kind: "working" },
      hold: HOLD,
    })],
  };

  it("says it stopped, why, and what to do — at the weight of a gate, not a footnote", () => {
    render(<IssueLifecycle issue={held} />);
    const block = container.querySelector('[data-testid="issue-lifecycle-hold"]');

    expect(block).not.toBeNull();
    expect(container.querySelector('[data-testid="issue-lifecycle-position"]')).toBeNull();
    expect(block!.textContent).toContain("This stopped at Spec");
    expect(block!.textContent).toContain("The Feature process has stopped and will not carry on by itself.");
    // The server's recorded reason, verbatim.
    expect(container.querySelector('[data-testid="issue-lifecycle-hold-detail"]')?.textContent)
      .toBe("Cancelled because issue assignee changed before the queued run could start");
    // And the way out, on the ticket rather than left to be guessed at.
    expect(container.querySelector('[data-testid="issue-lifecycle-hold-next-step"]')?.textContent)
      .toContain("re-run this step");
    expect([...container.querySelectorAll("a")].map((el) => el.getAttribute("href")))
      .toContain("/pipelines/pipeline-1/items/case-1");
  });

  it("gives a pending decision the floor when a ticket somehow has both", () => {
    render(
      <IssueLifecycle
        issue={{
          linkedCases: [linkedCase({
            hold: HOLD,
            review: { question: GATE_CONFIG.gate.prompt, config: GATE_CONFIG, stageNames: STAGE_NAMES },
          })],
        }}
      />,
    );
    // A gate can be answered here; a hold has to be cleared elsewhere.
    expect(container.querySelector('[data-testid="issue-lifecycle-gate"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="issue-lifecycle-hold"]')).toBeNull();
  });

  it("stays quiet about a hold on a process that has already finished", () => {
    // The server drops the hold for a terminal case; the strip must fall back
    // to its quiet sentence rather than to nothing.
    render(
      <IssueLifecycle
        issue={{ linkedCases: [linkedCase({ terminalKind: "done", status: "done", hold: null })] }}
      />,
    );
    expect(container.querySelector('[data-testid="issue-lifecycle-hold"]')).toBeNull();
    expect(container.querySelector('[data-testid="issue-lifecycle-position"]')?.textContent)
      .toBe("Finished the Feature process, at Promote.");
  });
});
