// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  slugBreakGlassPreview: vi.fn(),
  slugBreakGlassExecute: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

const mockApexSetupApi = vi.hoisted(() => ({
  githubOrgs: vi.fn(),
  auth: vi.fn(),
  gcpProjects: vi.fn(),
  githubRepos: vi.fn(),
}));

const mockOrgsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  companies: vi.fn(),
  linkCompany: vi.fn(),
}));

const mockScopeBindingApi = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

const mockProjectsApi = vi.hoisted(() => ({
  list: vi.fn(),
  listForCompany: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

let selectedCompany: Record<string, unknown> = {};

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/apex-setup", () => ({
  apexSetupApi: mockApexSetupApi,
  readCloudBinding: vi.fn(() => null),
  writeCloudBinding: vi.fn((env) => env),
}));

vi.mock("../api/apex-scoping", () => ({
  orgsApi: mockOrgsApi,
  scopeBindingApi: mockScopeBindingApi,
}));

vi.mock("../api/projects", () => ({
  projectsApi: mockProjectsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [selectedCompany],
    selectedCompany,
    selectedCompanyId: selectedCompany.id,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

import { CompanySettings } from "./CompanySettings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function baseCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    slug: "pap",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10 * 1024 * 1024,
    requireBoardApprovalForNewAgents: false,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-04-01T09:00:00.000Z"),
    updatedAt: new Date("2026-04-01T09:00:00.000Z"),
    ...overrides,
  };
}

describe("CompanySettings — slug field", () => {
  let container: HTMLDivElement;
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableCloudSync: false });
    mockApexSetupApi.githubOrgs.mockResolvedValue([]);
    mockApexSetupApi.auth.mockResolvedValue({
      google: { authed: false, live: false, account: null },
      github: { authed: false, live: false, user: null },
    });
    mockApexSetupApi.gcpProjects.mockResolvedValue({ projects: [] });
    mockApexSetupApi.githubRepos.mockResolvedValue({ repos: [] });
    mockOrgsApi.list.mockResolvedValue({ orgs: [] });
    mockOrgsApi.companies.mockResolvedValue([]);
    mockScopeBindingApi.get.mockResolvedValue(null);
    mockProjectsApi.list.mockResolvedValue([]);
    mockProjectsApi.listForCompany.mockResolvedValue([]);
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    confirmSpy.mockRestore();
    vi.clearAllMocks();
  });

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("renders the slug read-only with a lock affordance once set", async () => {
    selectedCompany = baseCompany({ slug: "pap" });
    const root = await render();

    const readonly = container.querySelector('[data-testid="company-settings-slug-readonly"]');
    expect(readonly).toBeTruthy();
    expect(readonly?.textContent).toContain("pap");
    expect(readonly?.querySelector("svg")).toBeTruthy();
    expect(container.querySelector('[data-testid="company-settings-slug-set"]')).toBeFalsy();
    // No editable input for slug when it's already set.
    expect(readonly?.querySelector("input")).toBeFalsy();

    await act(async () => {
      root.unmount();
    });
  });

  it("keeps the break-glass affordance behind a closed disclosure by default, revealed on toggle", async () => {
    selectedCompany = baseCompany({ slug: "pap" });
    const root = await render();

    // Closed by default: the disclosure toggle is present, but the destructive
    // "Force change slug" action and its dialog trigger are not rendered yet.
    const trigger = container.querySelector('[data-testid="company-settings-slug-breakglass-disclosure-trigger"]');
    expect(trigger).toBeTruthy();
    expect(container.querySelector('[data-testid="company-settings-slug-breakglass-open"]')).toBeFalsy();

    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const openButton = container.querySelector('[data-testid="company-settings-slug-breakglass-open"]');
    expect(openButton).toBeTruthy();
    expect(openButton?.textContent).toContain("Force change slug");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a one-time set field with a cannot-change warning when slug is null", async () => {
    selectedCompany = baseCompany({ slug: null });
    const root = await render();

    const setField = container.querySelector('[data-testid="company-settings-slug-set"]');
    expect(setField).toBeTruthy();
    expect(setField?.querySelector("input")).toBeTruthy();
    expect(container.textContent).toContain("cannot be changed later");
    expect(container.querySelector('[data-testid="company-settings-slug-readonly"]')).toBeFalsy();

    await act(async () => {
      root.unmount();
    });
  });

  it("confirms and saves the slug through a dedicated one-time set action", async () => {
    selectedCompany = baseCompany({ slug: null });
    mockCompaniesApi.update.mockResolvedValue(baseCompany({ slug: "acme" }));
    const root = await render();

    const input = container.querySelector(
      '[data-testid="company-settings-slug-set"] input',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Acme");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const setButton = Array.from(
      container.querySelectorAll('[data-testid="company-settings-slug-set"] button'),
    ).find((button) => button.textContent?.trim() === "Set slug") as HTMLButtonElement;
    expect(setButton).toBeTruthy();
    expect(setButton.disabled).toBe(false);

    await act(async () => {
      setButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { slug: "acme" });

    await act(async () => {
      root.unmount();
    });
  });
});
