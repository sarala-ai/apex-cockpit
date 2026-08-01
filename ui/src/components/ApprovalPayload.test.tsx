// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

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

/** Flush until react-query has settled the brief query — a single
 *  macrotask flush is flaky when the suite runs under load. */
async function flushUntil(predicate: () => boolean, attempts = 20) {
  for (let i = 0; i < attempts && !predicate(); i += 1) {
    await flushReact();
  }
}

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            risks: ["The frog might be too powerful."],
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});

/** The full brief the server assembles for the real APE-5 gate. */
const FULL_BRIEF = {
  available: true as const,
  decision: {
    headline: "Approve a design change",
    subject: "Board note: record the first governed design-change loop on Flows & gates",
    detail: "1 file changed in sarala-ai/apex-design — product/apex-platform.penpot.",
    flowPurpose: "A bounded agent step authors a design-board change…",
    ticketIdentifier: "APE-5",
  },
  verified: {
    headline: "Verified: the agent's run succeeded and the pull request it was required to open exists.",
    ok: true,
    machine: [
      "pr_exists:sarala-ai/apex-design#design/APE-5",
      "v1: run success + pr_exists verified (sarala-ai/apex-design#design/APE-5)",
    ],
  },
  artifact: {
    available: true as const,
    degraded: false as const,
    repo: "sarala-ai/apex-design",
    headBranch: "design/APE-5",
    url: "https://github.com/sarala-ai/apex-design/pull/2",
    title: "APE-5: Record first governed design-change loop",
    totals: { additions: 8, deletions: 2, changedFiles: 1 },
    files: [
      {
        path: "product/apex-platform.penpot",
        status: "modified",
        additions: 8,
        deletions: 2,
        binary: true,
        patch: null,
        patch_truncated: false,
      },
    ],
    files_truncated: false,
    acceptanceEvaluation: "v1: run success + pr_exists verified (sarala-ai/apex-design#design/APE-5)",
    artifactKind: "design" as const,
  },
  next: {
    approve: "Approve → workflow `design-pr-merge` runs on sarala-ai/apex-design (design/APE-5) and the flow completes.",
    reject:
      "Reject → the flow stops at this gate and stays paused; nothing further runs automatically. the pull request (sarala-ai/apex-design · design/APE-5) stays open for you to handle.",
    derived: true,
    note: null,
  },
  risk: {
    reversibility: "reversible" as const,
    reversibilityLine:
      "Reversible — what runs after this gate can be undone (a merge by a revert commit).",
    risks: ["1 changed file is binary, so no line-level diff exists for it."],
    derived: true,
  },
  waitingSince: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  provenance: {
    agentName: "Designer",
    agentId: "1673fb38-3674-4e7f-8546-4e9b56c5f49e",
    runId: "27dd2f74-3c3c-46b1-b0e5-b2434e78644d",
    permissionProfile: "bounded",
    permissionMode: "governed",
    commissionedAt: "2026-08-01T07:36:26.687Z",
    verifiedAt: "2026-08-01T07:40:20.528Z",
    gateOpenedAt: "2026-08-01T07:40:21.814Z",
  },
  machine: {
    approvalId: "approval-1",
    issueId: "1ab7eaf8-da14-454b-979c-7a11942fa629",
    flowName: "design-change",
    nodeId: "design_gate",
    ticketType: "design-change",
  },
};

describe("FlowGatePayload decision brief (via ApprovalPayloadRenderer type='flow_gate')", () => {
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
    act(() => {
      root.unmount();
    });
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
            payload={{
              flowName: "design-change",
              nodeId: "design_gate",
              prompt: "Review the design-board diff (.penpot pull request).",
            }}
          />
        </QueryClientProvider>,
      );
    });
  }

  it("renders all five brief sections in decision order", async () => {
    mockGetBrief.mockResolvedValue(FULL_BRIEF);
    renderGate();
    await flushUntil(() => !(container.textContent ?? "").includes("Preparing the decision brief"));

    const text = container.textContent ?? "";
    // 1 — what is being decided
    expect(text).toContain("You are deciding");
    expect(text).toContain("Approve a design change");
    expect(text).toContain("1 file changed in sarala-ai/apex-design");
    expect(text).toContain("APE-5: Board note: record the first governed design-change loop");
    // 2 — what was verified, in English
    expect(text).toContain("Already checked");
    expect(text).toContain("the agent's run succeeded and the pull request it was required to open exists");
    // 3 — what to look at
    expect(text).toContain("What to look at");
    expect(text).toContain("APE-5: Record first governed design-change loop");
    expect(text).toContain("product/apex-platform.penpot");
    expect(text).toContain("1 file");
    // 4 — what happens next
    expect(text).toContain("On approval");
    expect(text).toContain("design-pr-merge");
    expect(text).toContain("stops at this gate");
    // 5 — who did the work
    expect(text).toContain("Designer");
    expect(text).toContain("bounded permissions");

    // Section order: the decision comes before the artifact, which comes
    // before the consequences.
    const order = ["You are deciding", "Already checked", "What to look at", "On approval"];
    const positions = order.map((label) => text.indexOf(label));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("keeps machine strings out of the visible headline and behind a details affordance", async () => {
    mockGetBrief.mockResolvedValue(FULL_BRIEF);
    renderGate();
    await flushUntil(() => !!container.querySelector("#flow-gate-machine-approval-1"));

    const details = container.querySelector("#flow-gate-machine-approval-1") as HTMLElement | null;
    expect(details).not.toBeNull();
    expect(details?.hidden).toBe(true);

    const toggle = container.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(toggle.textContent).toContain("Technical details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect((container.querySelector("#flow-gate-machine-approval-1") as HTMLElement).hidden).toBe(false);
    expect(container.textContent).toContain("pr_exists:sarala-ai/apex-design#design/APE-5");
    expect(container.textContent).toContain("run: 27dd2f74-3c3c-46b1-b0e5-b2434e78644d");
  });

  it("renders a degraded artifact section without losing the rest of the brief", async () => {
    mockGetBrief.mockResolvedValue({
      ...FULL_BRIEF,
      decision: { ...FULL_BRIEF.decision, detail: "A pull request on sarala-ai/apex-design (design/APE-5)." },
      artifact: {
        available: true,
        degraded: true,
        repo: "sarala-ai/apex-design",
        headBranch: "design/APE-5",
        error: "apex CLI not found (bin: apex)",
        acceptanceEvaluation: null,
      },
    });
    renderGate();
    await flushUntil(() => (container.textContent ?? "").includes("apex CLI not found"));

    expect(container.textContent).toContain("apex CLI not found");
    expect(container.textContent).toContain("Approve a design change");
    expect(container.textContent).toContain("On approval");
  });

  it("renders a failed acceptance headline in plain language", async () => {
    mockGetBrief.mockResolvedValue({
      ...FULL_BRIEF,
      verified: {
        headline: "The check did NOT pass: the pull request the agent was required to open could not be found.",
        ok: false,
        machine: ["pr_exists:sarala-ai/apex-design#design/APE-5"],
      },
    });
    renderGate();
    await flushUntil(() => (container.textContent ?? "").includes("The check did NOT pass"));

    expect(container.textContent).toContain("The check did NOT pass");
    // Still not in the headline area — only behind the details toggle.
    const details = container.querySelector("#flow-gate-machine-approval-1") as HTMLElement;
    expect(details.hidden).toBe(true);
  });

  it("routes the artifact through the renderer registry — a design PR renders as a design, not a file row", async () => {
    mockGetBrief.mockResolvedValue(FULL_BRIEF);
    renderGate();
    await flushUntil(() => !!container.querySelector("[data-testid=artifact-design]"));

    expect(container.querySelector("[data-testid=artifact-design]")).not.toBeNull();
    expect(container.querySelector("[data-testid=artifact-file-list]")).toBeNull();
    // Nothing was invented: with no preview and no board names, it says so.
    expect(container.querySelector("[data-testid=design-no-preview]")?.textContent).toContain(
      "nothing about the visual change can be shown",
    );
  });

  it("shows the risk and reversibility of approving, in the board-approval vocabulary", async () => {
    mockGetBrief.mockResolvedValue(FULL_BRIEF);
    renderGate();
    await flushUntil(() => !!container.querySelector("[data-testid=flow-gate-reversibility]"));

    expect(container.querySelector("[data-testid=flow-gate-reversibility]")?.textContent).toContain(
      "Reversible",
    );
    expect(container.querySelector("[data-testid=flow-gate-risks]")?.textContent).toContain(
      "no line-level diff",
    );
    expect(container.textContent).toContain("Risks");
  });

  it("colours an irreversible consequence as the loudest thing on the card", async () => {
    mockGetBrief.mockResolvedValue({
      ...FULL_BRIEF,
      risk: {
        reversibility: "irreversible" as const,
        reversibilityLine:
          "NOT reversible — a step after this gate destroys or replaces something permanently.",
        risks: ["Workflow `destroy-staging` runs after this gate…"],
        derived: true,
      },
    });
    renderGate();
    await flushUntil(() => (container.textContent ?? "").includes("NOT reversible"));

    const line = container.querySelector("[data-testid=flow-gate-reversibility]") as HTMLElement;
    expect(line.className).toContain("text-red-700");
  });

  it("says how long the gate has been waiting on the founder", async () => {
    mockGetBrief.mockResolvedValue(FULL_BRIEF);
    renderGate();
    await flushUntil(() => !!container.querySelector("[data-testid=flow-gate-waiting-for]"));

    expect(container.querySelector("[data-testid=flow-gate-waiting-for]")?.textContent).toBe(
      "Waiting 3 hours",
    );
  });

  it("calls out a gate that has been waiting more than a day", async () => {
    mockGetBrief.mockResolvedValue({
      ...FULL_BRIEF,
      waitingSince: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    renderGate();
    await flushUntil(() => (container.textContent ?? "").includes("Waiting 3 days"));

    expect(container.querySelector("[data-testid=flow-gate-waiting-for]")?.textContent).toContain(
      "you are the bottleneck",
    );
  });

  it("omits the waiting line entirely when there is no timestamp to be honest about", async () => {
    mockGetBrief.mockResolvedValue({ ...FULL_BRIEF, waitingSince: null });
    renderGate();
    await flushUntil(() => !!container.querySelector("[data-testid=flow-gate-decision-brief]"));

    expect(container.querySelector("[data-testid=flow-gate-waiting-for]")).toBeNull();
  });

  it("renders a code PR as an actual diff, not a list of filenames", async () => {
    mockGetBrief.mockResolvedValue({
      ...FULL_BRIEF,
      artifact: {
        ...FULL_BRIEF.artifact,
        artifactKind: "code" as const,
        files: [
          {
            path: "server/src/routes/approvals.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            binary: false,
            patch: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
            patch_truncated: false,
          },
        ],
      },
    });
    renderGate();
    await flushUntil(() => !!container.querySelector("[data-testid=artifact-code]"));

    expect(container.textContent).toContain("+const a = 2;");
    expect(container.textContent).toContain("-const a = 1;");
    expect(container.querySelector("[data-testid=artifact-file-list]")).toBeNull();
  });

  it("renders a not-applicable state, falling back to the gate prompt", async () => {
    mockGetBrief.mockResolvedValue({
      available: false,
      reason: "no pr_exists acceptance found for this issue",
    });
    renderGate();
    await flushUntil(() => (container.textContent ?? "").includes("No decision brief"));

    expect(container.textContent).toContain("Review the design-board diff");
    expect(container.textContent).toContain("No decision brief could be assembled");
  });

  it("shows a loading state rather than an empty card", () => {
    mockGetBrief.mockReturnValue(new Promise(() => {}));
    renderGate();

    expect(container.textContent).toContain("Preparing the decision brief");
  });
});
