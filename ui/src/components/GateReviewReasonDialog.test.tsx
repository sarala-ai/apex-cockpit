// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GateReviewReasonDialog } from "./GateReviewReasonDialog";
import { ApprovalPayloadRenderer } from "./ApprovalPayload";

const mockGetBrief = vi.hoisted(() => vi.fn());
vi.mock("../api/approvals", () => ({
  approvalsApi: { getBrief: mockGetBrief },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function flushUntil(predicate: () => boolean, attempts = 20) {
  for (let i = 0; i < attempts && !predicate(); i += 1) {
    await flushReact();
  }
}

/** The dialog portals to document.body, so queries run there, not in container. */
function dialogText() {
  return document.body.textContent ?? "";
}
function reasonInput() {
  return document.body.querySelector<HTMLTextAreaElement>("[data-testid='gate-review-reason-input']");
}
function confirmButton() {
  return document.body.querySelector<HTMLButtonElement>("[data-testid='gate-review-reason-confirm']");
}

describe("GateReviewReasonDialog", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(node: React.ReactNode) {
    act(() => root.render(node));
  }

  function type(value: string) {
    const input = reasonInput()!;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("cannot be confirmed until a reason is written — the 400 is a backstop, not the path", () => {
    const onConfirm = vi.fn();
    render(
      <GateReviewReasonDialog
        open
        decision="request_changes"
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    );

    expect(confirmButton()!.disabled).toBe(true);
    act(() => confirmButton()!.click());
    expect(onConfirm).not.toHaveBeenCalled();

    type("The migration has no down step.");
    expect(confirmButton()!.disabled).toBe(false);
    act(() => confirmButton()!.click());
    expect(onConfirm).toHaveBeenCalledWith("The migration has no down step.");
  });

  it("treats a whitespace-only reason as no reason", () => {
    const onConfirm = vi.fn();
    render(
      <GateReviewReasonDialog open decision="reject" onOpenChange={() => {}} onConfirm={onConfirm} />,
    );
    type("   \n  ");
    expect(confirmButton()!.disabled).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("trims the reason it submits", () => {
    const onConfirm = vi.fn();
    render(
      <GateReviewReasonDialog
        open
        decision="request_changes"
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    );
    type("   fix the copy   ");
    act(() => confirmButton()!.click());
    expect(onConfirm).toHaveBeenCalledWith("fix the copy");
  });

  it("says what each decision does, so the two are not confused at the click", () => {
    render(
      <GateReviewReasonDialog
        open
        decision="request_changes"
        onOpenChange={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(dialogText()).toContain("goes back to the step that produced it");
    expect(dialogText()).toContain("verbatim");

    act(() => root.unmount());
    root = createRoot(container);
    render(
      <GateReviewReasonDialog open decision="reject" onOpenChange={() => {}} onConfirm={() => {}} />,
    );
    expect(dialogText()).toContain("stops the flow");
    expect(dialogText()).toContain("request changes instead");
  });

  it("starts empty each time it opens — a reason never carries into another decision", () => {
    const onConfirm = vi.fn();
    const props = { decision: "request_changes" as const, onOpenChange: () => {}, onConfirm };
    render(<GateReviewReasonDialog open {...props} />);
    type("first attempt");

    render(<GateReviewReasonDialog open={false} {...props} />);
    render(<GateReviewReasonDialog open {...props} />);
    expect(reasonInput()!.value).toBe("");
    expect(confirmButton()!.disabled).toBe(true);
  });

  it("shows a server error without discarding what the reviewer wrote", () => {
    render(
      <GateReviewReasonDialog
        open
        decision="reject"
        onOpenChange={() => {}}
        onConfirm={() => {}}
        error="Rejecting a flow gate requires a decision note."
      />,
    );
    type("my reason");
    expect(dialogText()).toContain("requires a decision note");
    expect(reasonInput()!.value).toBe("my reason");
  });
});

const BRIEF = {
  available: true as const,
  decision: {
    headline: "Approve a feature",
    subject: "Add the export button",
    detail: null,
    flowPurpose: null,
    ticketIdentifier: "APE-9",
  },
  verified: { headline: "Verified.", ok: true, machine: [] },
  artifact: { available: false as const, reason: "none" },
  reviewPasses: [],
  provenance: {
    agentName: null,
    agentId: null,
    runId: null,
    permissionProfile: null,
    permissionMode: null,
    commissionedAt: null,
    verifiedAt: null,
    gateOpenedAt: null,
  },
  machine: {
    approvalId: "approval-1",
    issueId: "issue-1",
    flowName: "feature",
    nodeId: "diff_gate",
    ticketType: "feature",
  },
};

describe("the decision brief states the request_changes consequence before the click", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    mockGetBrief.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderGate() {
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalPayloadRenderer
            type="flow_gate"
            approvalId="approval-1"
            payload={{ flowName: "feature", nodeId: "diff_gate" }}
          />
        </QueryClientProvider>,
      );
    });
  }

  it("shows which step reruns, between the approve and reject consequences", async () => {
    mockGetBrief.mockResolvedValue({
      ...BRIEF,
      next: {
        approve: "Approve → workflow `deploy` runs and the flow completes.",
        requestChanges:
          "Request changes (a reason is required) → step `tasks` reruns with your reason delivered to it verbatim. `task_checks` reruns on the way back, then this gate reopens on the new work for a fresh decision.",
        reject: "Reject → the flow stops at this gate and stays paused.",
        derived: true,
        note: null,
      },
    });
    renderGate();
    await flushUntil(() => (container.textContent ?? "").includes("On approval"));

    const text = container.textContent ?? "";
    expect(container.querySelector("[data-testid='flow-gate-next-request-changes']")).not.toBeNull();
    expect(text).toContain("step `tasks` reruns with your reason");
    expect(text).toContain("`task_checks` reruns on the way back");
    expect(text.indexOf("Approve →")).toBeLessThan(text.indexOf("Request changes ("));
    expect(text.indexOf("Request changes (")).toBeLessThan(text.indexOf("Reject →"));
  });

  it("says nothing about rerunning where the gate has no step to route back to", async () => {
    mockGetBrief.mockResolvedValue({
      ...BRIEF,
      next: {
        approve: "Approve → the spec step is commissioned.",
        requestChanges: null,
        reject:
          "Reject → the flow stops at this gate and stays paused. No step precedes this gate that could redo the work, so requesting changes is not available here.",
        derived: true,
        note: null,
      },
    });
    renderGate();
    await flushUntil(() => (container.textContent ?? "").includes("On approval"));

    expect(container.querySelector("[data-testid='flow-gate-next-request-changes']")).toBeNull();
    expect(container.textContent).toContain("requesting changes is not available here");
  });
});
