// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalPayloadRenderer, approvalLabel } from "./ApprovalPayload";

const mockGetPrDiff = vi.hoisted(() => vi.fn());
vi.mock("../api/approvals", () => ({
  approvalsApi: { getPrDiff: mockGetPrDiff },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
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

describe("FlowGatePayload (via ApprovalPayloadRenderer type='flow_gate')", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    mockGetPrDiff.mockReset();
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
              flowName: "design-change-flow",
              nodeId: "gate-review",
              prompt: "Review the proposed design change before merging.",
            }}
          />
        </QueryClientProvider>,
      );
    });
  }

  it("renders the PR title, totals, and file list on success", async () => {
    mockGetPrDiff.mockResolvedValue({
      available: true,
      degraded: false,
      repo: "sarala-ai/apex-design",
      headBranch: "design/APE-5",
      url: "https://github.com/sarala-ai/apex-design/pull/2",
      title: "APE-5: Record first governed design-change loop",
      totals: { additions: 8, deletions: 2, changedFiles: 1 },
      files: [
        { path: "product/apex-platform.penpot", status: "modified", additions: 8, deletions: 2 },
      ],
      files_truncated: false,
      acceptanceEvaluation: "v1: run success + pr_exists verified (sarala-ai/apex-design#design/APE-5)",
    });

    renderGate();
    await flushReact();

    expect(container.textContent).toContain("Review the proposed design change before merging.");
    expect(container.textContent).toContain("APE-5: Record first governed design-change loop");
    expect(container.textContent).toContain("product/apex-platform.penpot");
    expect(container.textContent).toContain("+8");
    expect(container.textContent).toContain("-2");
    expect(container.textContent).toContain("1 file");
    expect(container.textContent).toContain("v1: run success + pr_exists verified");
  });

  it("renders a degraded state when the CLI/gh call fails, without throwing", async () => {
    mockGetPrDiff.mockResolvedValue({
      available: true,
      degraded: true,
      repo: "sarala-ai/apex-design",
      headBranch: "design/APE-5",
      error: "apex CLI not found (bin: apex)",
      acceptanceEvaluation: null,
    });

    renderGate();
    await flushReact();

    expect(container.textContent).toContain("Couldn");
    expect(container.textContent).toContain("apex CLI not found");
  });

  it("renders a not-applicable state when no pr_exists acceptance is found", async () => {
    mockGetPrDiff.mockResolvedValue({
      available: false,
      reason: "no pr_exists acceptance found for this issue",
    });

    renderGate();
    await flushReact();

    expect(container.textContent).toContain("No linked pull request found");
  });
});
