// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalReview } from "./ProposalReview";

const mockProposalsApi = vi.hoisted(() => ({
  get: vi.fn(),
  kinds: vi.fn(),
  correctRecord: vi.fn(),
  submit: vi.fn(),
  exportCsvUrl: (id: string) => `/api/proposals/${id}/export.csv`,
}));
const mockApprovalsApi = vi.hoisted(() => ({
  approve: vi.fn(),
  requestRevision: vi.fn(),
}));

vi.mock("../api/proposals", () => ({ proposalsApi: mockProposalsApi }));
vi.mock("../api/approvals", () => ({ approvalsApi: mockApprovalsApi }));

const setBreadcrumbs = vi.hoisted(() => vi.fn());
vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ proposalId: "proposal-1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    id: "proposal-1",
    companyId: "company-1",
    kind: "initiatives",
    title: "26 reconstructed initiatives",
    summary: "Reconstructed from six months of commits",
    status: "in_review",
    approvalId: "approval-1",
    materializedAt: null,
    materialization: null,
    records: [
      {
        ref: "r1",
        targetId: "goal-1",
        provenance: { kind: "inferred", source: "47 commits, March–May" },
        fields: { title: "Run FinPilot and Bloom through APEX", budget: "8 weeks" },
        note: null,
      },
      {
        ref: "r2",
        provenance: { kind: "confirmed", source: "design doc" },
        fields: { title: "State that survives the run" },
        note: null,
      },
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("ProposalReview", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockProposalsApi.kinds.mockResolvedValue([
      {
        kind: "initiatives",
        label: "Initiative",
        columns: [
          { key: "title", label: "Title", editable: true },
          { key: "budget", label: "Budget", editable: true },
          { key: "stopCondition", label: "Stop condition", editable: true, multiline: true },
        ],
      },
    ]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProposalReview />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("renders the records as a scannable grid using the kind's columns", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    const root = await render();
    expect(container.querySelector("[data-testid='proposal-grid']")).toBeTruthy();
    expect(container.textContent).toContain("Title");
    expect(container.textContent).toContain("Stop condition");
    expect(container.textContent).toContain("Run FinPilot and Bloom through APEX");
    await act(async () => root.unmount());
  });

  it("shows provenance per row, so a reviewer can find the reconstructions", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    const root = await render();
    const first = container.querySelector("[data-testid='proposal-row-r1']");
    expect(first?.textContent).toContain("inferred");
    expect(first?.textContent).toContain("47 commits, March–May");
    const second = container.querySelector("[data-testid='proposal-row-r2']");
    expect(second?.textContent).toContain("confirmed");
    await act(async () => root.unmount());
  });

  it("says whether approving a row creates or updates a board object", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    const root = await render();
    expect(container.querySelector("[data-testid='proposal-row-r1']")?.textContent).toContain(
      "update",
    );
    expect(container.querySelector("[data-testid='proposal-row-r2']")?.textContent).toContain(
      "create",
    );
    await act(async () => root.unmount());
  });

  it("counts the set up front, including how many rows are inferred", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    const root = await render();
    expect(container.textContent).toContain("2 records");
    expect(container.textContent).toContain("1 inferred");
    await act(async () => root.unmount());
  });

  it("corrects one cell in place without touching the rest of the row", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    mockProposalsApi.correctRecord.mockResolvedValue({
      proposal: proposal(),
      record: { ref: "r1" },
      fieldsError: null,
    });
    const root = await render();

    const row = container.querySelector("[data-testid='proposal-row-r1']")!;
    const budgetCell = [...row.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Edit Budget",
    )!;
    await act(async () => budgetCell.click());

    const input = row.querySelector<HTMLInputElement>("input[aria-label='Budget']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(input, "12 weeks");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // React delegates onBlur through focusout; a plain blur event never fires it.
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await flushReact();

    expect(mockProposalsApi.correctRecord).toHaveBeenCalledWith("proposal-1", "r1", {
      fields: { budget: "12 weeks" },
    });
    await act(async () => root.unmount());
  });

  it("drops a row on the proposal, never on the board", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    mockProposalsApi.correctRecord.mockResolvedValue({
      proposal: proposal(),
      record: { ref: "r1" },
      fieldsError: null,
    });
    const root = await render();
    const row = container.querySelector("[data-testid='proposal-row-r1']")!;
    const drop = [...row.querySelectorAll("button")].find(
      (button) => button.textContent === "Drop",
    )!;
    await act(async () => drop.click());
    expect(mockProposalsApi.correctRecord).toHaveBeenCalledWith("proposal-1", "r1", {
      excluded: true,
    });
    await act(async () => root.unmount());
  });

  it("approves the whole set through the single gate", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    mockApprovalsApi.approve.mockResolvedValue({});
    const root = await render();
    const approve = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Approve"),
    )!;
    await act(async () => approve.click());
    await flushReact();
    expect(mockApprovalsApi.approve).toHaveBeenCalledWith("approval-1", undefined);
    await act(async () => root.unmount());
  });

  it("will not request changes without a reason — the reason IS the instruction", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    const root = await render();
    const requestChanges = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Request changes"),
    )! as HTMLButtonElement;
    expect(requestChanges.disabled).toBe(true);
    await act(async () => root.unmount());
  });

  it("says out loud that nothing exists on the board until approval", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    const root = await render();
    expect(container.textContent).toContain("Nothing exists on the board until this is approved");
    await act(async () => root.unmount());
  });

  it("offers the gate only once the proposal has been submitted", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal({ status: "draft", approvalId: null }));
    const root = await render();
    expect(container.textContent).toContain("Send to gate");
    expect(container.textContent).not.toContain("Approve &");
    await act(async () => root.unmount());
  });

  it("reports what materialisation actually did once approved", async () => {
    mockProposalsApi.get.mockResolvedValue(
      proposal({
        status: "approved",
        materialization: { created: ["g1"], updated: ["g2", "g3"], skipped: [], errors: [] },
      }),
    );
    const root = await render();
    const result = container.querySelector("[data-testid='materialization-result']");
    expect(result?.textContent).toContain("1 created");
    expect(result?.textContent).toContain("2 updated");
    // A decided proposal is a record of the review, not an editable sheet.
    expect(container.textContent).not.toContain("Approve &");
    await act(async () => root.unmount());
  });

  it("says so plainly when a proposal carries no records", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal({ records: [] }));
    const root = await render();
    expect(container.querySelector("[data-testid='proposal-grid-empty']")?.textContent).toContain(
      "nothing to review",
    );
    await act(async () => root.unmount());
  });

  it("offers a CSV export for reading the set offline", async () => {
    mockProposalsApi.get.mockResolvedValue(proposal());
    const root = await render();
    const link = container.querySelector<HTMLAnchorElement>("a[download]");
    expect(link?.getAttribute("href")).toBe("/api/proposals/proposal-1/export.csv");
    await act(async () => root.unmount());
  });
});
