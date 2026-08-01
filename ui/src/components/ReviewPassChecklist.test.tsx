// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPassChecklist } from "./ReviewPassChecklist";
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

const PASSES = [
  {
    id: "customer_hat",
    label: "Customer hat",
    question: "Would a first-time user understand this screen without knowing how it was built?",
  },
  {
    id: "cognitive_load",
    label: "Cognitive load",
    question: "Does this remove noise without hiding consequences?",
  },
];

describe("ReviewPassChecklist", () => {
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

  it("renders nothing at all when the gate declares no passes", () => {
    render(<ReviewPassChecklist passes={[]} onChange={() => {}} />);
    expect(container.querySelector("[data-testid='review-pass-checklist']")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("shows each pass as one question, in declared order", () => {
    render(<ReviewPassChecklist passes={PASSES} acknowledged={[]} onChange={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Before you decide");
    expect(text).toContain("Would a first-time user understand this screen");
    expect(text).toContain("Does this remove noise without hiding consequences?");
    expect(text.indexOf("first-time user")).toBeLessThan(text.indexOf("remove noise"));
  });

  it("says plainly that ticking is optional — the checklist never blocks the decision", () => {
    render(<ReviewPassChecklist passes={PASSES} acknowledged={[]} onChange={() => {}} />);
    expect(container.textContent).toContain("never blocks the decision");
  });

  it("reports ticked ids in pass order as the approver acknowledges them", () => {
    const onChange = vi.fn();
    render(<ReviewPassChecklist passes={PASSES} acknowledged={["cognitive_load"]} onChange={onChange} />);
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.checked).toBe(false);
    expect(boxes[1]!.checked).toBe(true);

    act(() => boxes[0]!.click());
    expect(onChange).toHaveBeenCalledWith(["customer_hat", "cognitive_load"]);
  });

  it("un-ticks an acknowledged pass", () => {
    const onChange = vi.fn();
    render(
      <ReviewPassChecklist passes={PASSES} acknowledged={["customer_hat"]} onChange={onChange} />,
    );
    const boxes = Array.from(container.querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    act(() => boxes[0]!.click());
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("renders the questions without checkboxes where the decision is not submitted", () => {
    render(<ReviewPassChecklist passes={PASSES} />);
    expect(container.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
    expect(container.textContent).toContain("Would a first-time user understand this screen");
    expect(container.textContent).not.toContain("never blocks the decision");
  });
});

const BRIEF_BASE = {
  available: true as const,
  decision: {
    headline: "Approve a design change",
    subject: "A board change",
    detail: null,
    flowPurpose: null,
    ticketIdentifier: "APE-5",
  },
  verified: { headline: "Verified.", ok: true, machine: [] },
  artifact: { available: false as const, reason: "none" },
  next: { approve: "Approve → merge runs.", reject: "Reject → paused.", derived: true, note: null },
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
    flowName: "design-change",
    nodeId: "design_gate",
    ticketType: "design-change",
  },
};

describe("FlowGatePayload renders the gate's review passes", () => {
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

  function renderGate(onChange?: (ids: string[]) => void) {
    root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalPayloadRenderer
            type="flow_gate"
            approvalId="approval-1"
            payload={{ flowName: "design-change", nodeId: "design_gate" }}
            acknowledgedReviewPasses={[]}
            onAcknowledgedReviewPassesChange={onChange}
          />
        </QueryClientProvider>,
      );
    });
  }

  it("shows the checklist between the artifact and the consequences", async () => {
    mockGetBrief.mockResolvedValue({ ...BRIEF_BASE, reviewPasses: PASSES });
    renderGate(() => {});
    await flushUntil(() => (container.textContent ?? "").includes("Before you decide"));

    const text = container.textContent ?? "";
    expect(text).toContain("Would a first-time user understand this screen");
    expect(text.indexOf("What to look at")).toBeLessThan(text.indexOf("Before you decide"));
    expect(text.indexOf("Before you decide")).toBeLessThan(text.indexOf("On approval"));
  });

  it("hands ticks back to the surface that submits the decision", async () => {
    const onChange = vi.fn();
    mockGetBrief.mockResolvedValue({ ...BRIEF_BASE, reviewPasses: PASSES });
    renderGate(onChange);
    await flushUntil(() => (container.textContent ?? "").includes("Before you decide"));

    const box = container.querySelector<HTMLInputElement>("input[type=checkbox]");
    act(() => box!.click());
    expect(onChange).toHaveBeenCalledWith(["customer_hat"]);
  });

  it("renders no checklist section when the gate declares no passes", async () => {
    mockGetBrief.mockResolvedValue({ ...BRIEF_BASE, reviewPasses: [] });
    renderGate(() => {});
    await flushUntil(() => (container.textContent ?? "").includes("On approval"));
    expect(container.textContent).not.toContain("Before you decide");
    expect(container.querySelector("[data-testid='review-pass-checklist']")).toBeNull();
  });

  it("renders no checklist section when the brief predates review passes", async () => {
    mockGetBrief.mockResolvedValue(BRIEF_BASE);
    renderGate(() => {});
    await flushUntil(() => (container.textContent ?? "").includes("On approval"));
    expect(container.textContent).not.toContain("Before you decide");
  });
});
