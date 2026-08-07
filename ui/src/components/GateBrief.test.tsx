// @vitest-environment jsdom

/**
 * What a person actually sees when a decision is waiting on them.
 *
 * The critique this closes is about CONTENT, not layout — a gate that renders
 * a card and says "Gate 1: Promote — is it worth doing. Seconds." is exactly
 * as hollow as a gate that renders nothing. So these read the words on the
 * screen, and check the two properties the brief exists for: the artifact is
 * handed over (with a way to the whole of it), and an absence is stated
 * rather than left blank.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetBrief = vi.hoisted(() => vi.fn());
vi.mock("../api/approvals", () => ({
  approvalsApi: { getBrief: mockGetBrief },
}));
vi.mock("react-router-dom", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

import { GateBrief, gateBriefItemHref } from "./GateBrief";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let root: any;

beforeEach(() => {
  mockGetBrief.mockReset();
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

async function renderBrief(props: { approvalId: string | null; fallbackQuestion?: string | null }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <GateBrief {...props} />
      </QueryClientProvider>,
    );
  });
  // Let the query settle. A couple of macrotask turns is enough for a
  // resolved (or immediately-absent) fetch to land and re-render.
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const SPEC_GATE_BRIEF = {
  available: true,
  kind: "pipeline_gate",
  deciding: {
    headline: "Specifier finished Spec 3 hours ago. You are deciding whether it goes on to Tasks.",
    question: "Gate 2: Spec approval — the load-bearing gate.",
    subject: "Gate briefs hand over the artifact",
    ticketIdentifier: "APEX-14",
    ticketId: "issue-1",
    outcomes: [
      { decision: "approve", line: "Approve — this moves on to Tasks." },
      { decision: "reject", line: "Stop it here — this moves to Cancelled and nothing further runs. A reason is required." },
    ],
    waitingFor: "This has been waiting 3 hours for your decision.",
  },
  lookAt: {
    headline: "Spec produced this.",
    items: [
      {
        label: "Spec",
        excerpt: "# Spec\n\n## Task 1 — assemble the brief",
        truncated: true,
        anchor: "spec",
        url: null,
        meta: "Written by Specifier, 3 hours ago",
      },
    ],
    nothingThere: null,
  },
  checked: {
    headline: "Checked by the machine, and it passed.",
    ok: true,
    detail: "Spec produced what it promised to produce.",
    machine: ["file_exists:specs/gate-brief.md"],
  },
  history: ["You approved Promote 2 days ago."],
  reviewPasses: [{ id: "design", label: "Design", question: "Does this fit the system's shape?" }],
  machine: {
    approvalId: "approval-1",
    caseId: "case-1",
    pipelineKey: "feature",
    stepKey: "spec_design_gate",
    workVersion: 4,
  },
};

describe("the decision brief on a surface", () => {
  it("hands over the document itself, and a way to the rest of it", async () => {
    mockGetBrief.mockResolvedValue(SPEC_GATE_BRIEF);
    await renderBrief({ approvalId: "approval-1" });

    const text = container.textContent ?? "";
    expect(text).toContain("Specifier finished Spec 3 hours ago");
    expect(text).toContain("## Task 1 — assemble the brief");
    expect(text).toContain("This is the start of it, not all of it.");
    expect(text).toContain("Checked by the machine, and it passed.");
    expect(text).toContain("You approved Promote 2 days ago.");
    // The whole thing, one click away.
    expect(container.querySelector('a[href="/issues/issue-1#document-spec"]')).not.toBeNull();
  });

  it("shows what each answer does before the person answers", async () => {
    mockGetBrief.mockResolvedValue(SPEC_GATE_BRIEF);
    await renderBrief({ approvalId: "approval-1" });

    const text = container.textContent ?? "";
    expect(text).toContain("Approve — this moves on to Tasks.");
    expect(text).toContain("this moves to Cancelled and nothing further runs");
    expect(text).toContain("This has been waiting 3 hours for your decision.");
  });

  it("keeps the raw check behind a details affordance rather than in the copy", async () => {
    mockGetBrief.mockResolvedValue(SPEC_GATE_BRIEF);
    await renderBrief({ approvalId: "approval-1" });

    expect(container.textContent).not.toContain("file_exists:");
    const toggle = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Show the exact check"),
    );
    expect(toggle).toBeDefined();
    await act(async () => {
      toggle!.click();
    });
    expect(container.textContent).toContain("file_exists:specs/gate-brief.md");
  });

  it("states an absence rather than rendering a blank section", async () => {
    mockGetBrief.mockResolvedValue({
      ...SPEC_GATE_BRIEF,
      lookAt: {
        headline: "Spec finished and left nothing to read.",
        items: [],
        nothingThere:
          "Spec completed, but it wrote no document, opened no change and left no note.",
      },
    });
    await renderBrief({ approvalId: "approval-1" });

    expect(container.querySelector('[data-testid="gate-brief-artifact"]')).toBeNull();
    expect(container.querySelector('[data-testid="gate-brief-nothing-there"]')?.textContent)
      .toContain("wrote no document, opened no change and left no note");
  });

  it("says nothing about history when nothing in it would change the answer", async () => {
    mockGetBrief.mockResolvedValue({ ...SPEC_GATE_BRIEF, history: [] });
    await renderBrief({ approvalId: "approval-1" });

    expect(container.querySelector('[data-testid="gate-brief-history"]')).toBeNull();
    expect(container.textContent).not.toContain("Worth knowing first");
  });

  it("falls back to the question the process asked when no brief can be had", async () => {
    await renderBrief({ approvalId: null, fallbackQuestion: "Gate 1: Promote — is it worth doing." });

    expect(mockGetBrief).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="gate-brief-fallback"]')?.textContent)
      .toBe("Gate 1: Promote — is it worth doing.");
  });

  it("falls back rather than rendering an older flow-shaped brief it does not own", async () => {
    mockGetBrief.mockResolvedValue({ available: true, kind: "flow_gate", decision: {} });
    await renderBrief({ approvalId: "approval-1", fallbackQuestion: "Review the diff." });

    expect(container.querySelector('[data-testid="gate-brief"]')).toBeNull();
    expect(container.querySelector('[data-testid="gate-brief-fallback"]')?.textContent).toBe("Review the diff.");
  });
});

describe("where an artifact lives", () => {
  const item = { label: "Spec", excerpt: null, truncated: false, anchor: "spec", url: null, meta: null };

  it("anchors a document on its own ticket", () => {
    expect(gateBriefItemHref(item, "issue-1")).toBe("/issues/issue-1#document-spec");
  });

  it("prefers an external artifact's own address", () => {
    expect(gateBriefItemHref({ ...item, url: "https://github.com/a/b/pull/2" }, "issue-1"))
      .toBe("https://github.com/a/b/pull/2");
  });

  it("invents no link for an artifact that has none", () => {
    expect(gateBriefItemHref(item, null)).toBeNull();
    expect(gateBriefItemHref({ ...item, anchor: null }, "issue-1")).toBeNull();
  });
});
