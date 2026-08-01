// @vitest-environment jsdom

// Coverage for the onboarding identity step (PAP company-setup identity):
// the wizard's Company name step now shows a server-derived issue prefix +
// slug preview (debounced), lets the operator override either field, tracks
// which fields have been hand-edited so the name-driven preview never
// clobbers an edit, surfaces availability/format validation before submit,
// and — when a field was edited — sends that explicit value through
// companiesApi.create() instead of letting the server re-derive it.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, CompanyIdentityPreview } from "@paperclipai/shared";
import { OnboardingWizard } from "./OnboardingWizard";
import { DialogProvider } from "../context/DialogContext";
import { CompanyProvider } from "../context/CompanyContext";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  identityPreview: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

const mockAdaptersApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/api/adapters", () => ({
  adaptersApi: mockAdaptersApi,
}));

function makeCompany(id: string, issuePrefix: string): Company {
  return {
    id,
    name: issuePrefix,
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix,
    slug: issuePrefix.toLowerCase(),
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10 * 1024 * 1024,
    defaultResponsibleUserId: null,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function preview(overrides: Partial<CompanyIdentityPreview> & { name: string }): CompanyIdentityPreview {
  return {
    issuePrefix: "",
    slug: "",
    prefixAvailable: true,
    slugAvailable: true,
    suggestedPrefix: null,
    suggestedSlug: null,
    ...overrides,
  };
}

async function flushReactMicrotasks() {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
  flushSync(() => {});
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("OnboardingWizard identity step", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function render() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <MemoryRouter initialEntries={["/onboarding"]}>
          <QueryClientProvider client={queryClient}>
            <DialogProvider>
              <CompanyProvider>
                <OnboardingWizard />
              </CompanyProvider>
            </DialogProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReactMicrotasks();
  }

  function nameInput() {
    return document.body.querySelector('[data-testid="onboarding-company-name-input"]') as HTMLInputElement;
  }
  function prefixInput() {
    return document.body.querySelector('[data-testid="onboarding-issue-prefix-input"]') as HTMLInputElement | null;
  }
  function slugInput() {
    return document.body.querySelector('[data-testid="onboarding-slug-input"]') as HTMLInputElement | null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // AsciiArtAnimation (mounted alongside every wizard step) reads
    // prefers-reduced-motion — jsdom has no matchMedia implementation.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    if (typeof window.ResizeObserver === "undefined") {
      class NoopResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
      window.ResizeObserver = NoopResizeObserver;
    }
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompaniesApi.list.mockReset().mockResolvedValue([]);
    mockCompaniesApi.stats.mockReset().mockResolvedValue({});
    mockCompaniesApi.identityPreview.mockReset();
    mockCompaniesApi.create.mockReset();
    mockAdaptersApi.list.mockReset().mockResolvedValue([]);
    localStorage.clear();
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("debounces the identity preview request as the company name is typed", async () => {
    mockCompaniesApi.identityPreview.mockResolvedValue(
      preview({ name: "Acme", issuePrefix: "ACME", slug: "acme" }),
    );
    await render();

    setInputValue(nameInput(), "A");
    await vi.advanceTimersByTimeAsync(100);
    setInputValue(nameInput(), "Ac");
    await vi.advanceTimersByTimeAsync(100);
    setInputValue(nameInput(), "Acme");
    await vi.advanceTimersByTimeAsync(100);

    // Still within the debounce window from the LAST keystroke — no request yet.
    expect(mockCompaniesApi.identityPreview).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    await flushReactMicrotasks();

    expect(mockCompaniesApi.identityPreview).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.identityPreview).toHaveBeenCalledWith(
      "Acme",
      { issuePrefix: undefined, slug: undefined },
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("pre-fills the issue prefix and slug fields from the preview response", async () => {
    mockCompaniesApi.identityPreview.mockResolvedValue(
      preview({ name: "Acme Corp", issuePrefix: "ACM", slug: "acm" }),
    );
    await render();

    setInputValue(nameInput(), "Acme Corp");
    await vi.advanceTimersByTimeAsync(400);
    await flushReactMicrotasks();

    expect(prefixInput()!.value).toBe("ACM");
    expect(slugInput()!.value).toBe("acm");
  });

  it("does not clobber a hand-edited prefix when the name changes again (dirty-field tracking)", async () => {
    mockCompaniesApi.identityPreview
      .mockResolvedValueOnce(preview({ name: "Acme Corp", issuePrefix: "ACM", slug: "acm" }))
      .mockResolvedValueOnce(preview({ name: "Acme Corporation", issuePrefix: "ACM", slug: "acm" }));
    await render();

    setInputValue(nameInput(), "Acme Corp");
    await vi.advanceTimersByTimeAsync(400);
    await flushReactMicrotasks();
    expect(prefixInput()!.value).toBe("ACM");

    // Operator hand-edits the prefix away from the derived default.
    setInputValue(prefixInput()!, "ACME1");
    await flushReactMicrotasks();
    expect(prefixInput()!.value).toBe("ACME1");

    // Then keeps typing the company name — a classic bug spot: the next
    // debounced preview response must NOT overwrite what was just typed.
    setInputValue(nameInput(), "Acme Corporation");
    await vi.advanceTimersByTimeAsync(400);
    await flushReactMicrotasks();

    expect(prefixInput()!.value).toBe("ACME1");
    // The slug field is still untouched, so it DOES track the new preview.
    expect(slugInput()!.value).toBe("acm");
  });

  it("shows an inline conflict and a suggestion when the prefix is taken, and disables Next", async () => {
    mockCompaniesApi.identityPreview.mockResolvedValue(
      preview({
        name: "Acme",
        issuePrefix: "ACM",
        slug: "acm",
        prefixAvailable: false,
        suggestedPrefix: "ACMA",
        suggestedSlug: "acma",
      }),
    );
    await render();

    setInputValue(nameInput(), "Acme");
    await vi.advanceTimersByTimeAsync(400);
    await flushReactMicrotasks();

    expect(document.body.textContent).toContain("Already used by another company");
    expect(document.body.textContent).toContain("ACMA");

    const nextButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim().startsWith("Next"),
    ) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(true);
  });

  it("flags an invalid hand-typed slug format before submit", async () => {
    mockCompaniesApi.identityPreview.mockResolvedValue(
      preview({ name: "Acme", issuePrefix: "ACM", slug: "acm" }),
    );
    await render();

    setInputValue(nameInput(), "Acme");
    await vi.advanceTimersByTimeAsync(400);
    await flushReactMicrotasks();

    setInputValue(slugInput()!, "Not A Slug!");
    await flushReactMicrotasks();

    expect(document.body.textContent).toContain("Lowercase letters, numbers, and hyphens only");
  });

  it("sends the hand-edited issuePrefix/slug through create() when the operator overrode them", async () => {
    mockCompaniesApi.identityPreview.mockResolvedValue(
      preview({ name: "Acme", issuePrefix: "ACM", slug: "acm" }),
    );
    mockCompaniesApi.create.mockResolvedValue(makeCompany("company-1", "CUSTOM"));

    await render();

    setInputValue(nameInput(), "Acme");
    await vi.advanceTimersByTimeAsync(400);
    await flushReactMicrotasks();

    setInputValue(prefixInput()!, "CUSTOM");
    await flushReactMicrotasks();
    setInputValue(slugInput()!, "custom-slug");
    await flushReactMicrotasks();

    const nextButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.trim().startsWith("Next"),
    ) as HTMLButtonElement;
    expect(nextButton.disabled).toBe(false);
    flushSync(() => {
      nextButton.click();
    });
    await flushReactMicrotasks();

    // Land on step 2 (Define your mission) and pick the direct mission path,
    // which is auto-selected by the Next click above; fill in the goal and
    // confirm, driving handleConfirmMission -> companiesApi.create().
    const missionInput = document.body.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(missionInput).toBeTruthy();
    setInputValue(missionInput as HTMLTextAreaElement, "Ship the thing");
    await flushReactMicrotasks();

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Confirm mission"),
    ) as HTMLButtonElement;
    expect(confirmButton).toBeTruthy();
    flushSync(() => {
      confirmButton.click();
    });
    await flushReactMicrotasks();

    expect(mockCompaniesApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Acme",
        issuePrefix: "CUSTOM",
        slug: "custom-slug",
      }),
    );
  });
});
