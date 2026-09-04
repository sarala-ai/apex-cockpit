// @vitest-environment jsdom
//
// Hosted-cockpit discovery fallback: when `/setup/gcp/projects` and
// `/setup/github/repos` carry `reason: "operator_workstation_required"` (no
// gcloud/gh to shell out to on a Cloud Run cockpit), the scope binding editor
// must render an honest text-entry instead of the picker chips — never a
// silently-empty picker that reads as "you have zero projects".

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgScopingSection } from "./OrgScopingSection";
import { apexSetupApi } from "../../api/apex-setup";
import { orgsApi, scopeBindingApi } from "../../api/apex-scoping";

vi.mock("../../api/apex-setup", async () => {
  const actual = await vi.importActual<typeof import("../../api/apex-setup")>("../../api/apex-setup");
  return {
    ...actual,
    apexSetupApi: {
      ...actual.apexSetupApi,
      gcpProjects: vi.fn(),
      githubRepos: vi.fn(),
      githubOrgs: vi.fn(),
    },
  };
});

vi.mock("../../api/apex-scoping", async () => {
  const actual = await vi.importActual<typeof import("../../api/apex-scoping")>("../../api/apex-scoping");
  return {
    ...actual,
    orgsApi: {
      ...actual.orgsApi,
      list: vi.fn(),
      companies: vi.fn(),
    },
    scopeBindingApi: {
      get: vi.fn(),
      put: vi.fn(),
    },
  };
});

const ORG = { id: "org-1", name: "Sarala", githubOrg: "sarala-ai", governancePosture: "individual" as const };
const COMPANY = { id: "co-1", name: "FinPilot", orgId: "org-1" };
const WORKSTATION = {
  reportedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  gcloud: { account: "me@example.com", live: true },
  gh: { user: "me" },
};

async function flushReact() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function renderSection(container: HTMLDivElement): Promise<Root> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <OrgScopingSection companyId={COMPANY.id} slice="all" />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return root;
}

describe("OrgScopingSection — hosted discovery fallback", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    vi.mocked(orgsApi.list).mockResolvedValue({ orgs: [ORG] });
    vi.mocked(orgsApi.companies).mockResolvedValue({ companies: [COMPANY] });
    vi.mocked(scopeBindingApi.get).mockResolvedValue({
      scopeType: "company",
      scopeId: COMPANY.id,
      gcpProjects: [],
      githubRepos: [],
    });
    vi.mocked(scopeBindingApi.put).mockResolvedValue({
      scopeType: "company",
      scopeId: COMPANY.id,
      gcpProjects: [],
      githubRepos: [],
    });
    vi.mocked(apexSetupApi.gcpProjects).mockResolvedValue({
      projects: [],
      source: "unavailable",
      reason: "operator_workstation_required",
      workstation: WORKSTATION,
    });
    vi.mocked(apexSetupApi.githubRepos).mockResolvedValue({
      repos: [],
      source: "unavailable",
      reason: "operator_workstation_required",
      workstation: WORKSTATION,
    });
    vi.mocked(apexSetupApi.githubOrgs).mockResolvedValue({ orgs: [], source: "unavailable" });
  });

  afterEach(async () => {
    await act(async () => {
      container.remove();
    });
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("renders the text-entry state + workstation hint instead of picker chips", async () => {
    const root = await renderSection(container);

    const companyBinding = container.querySelector('[data-testid="apex-company-scope-binding"]');
    expect(companyBinding).toBeTruthy();
    expect(companyBinding!.textContent).toContain("Discovery runs on your workstation");
    expect(companyBinding!.textContent).toContain("this cockpit can't list your GCP projects");
    expect(companyBinding!.textContent).toContain("Last reported by your workstation");
    expect(companyBinding!.querySelector('[data-testid="apex-scope-project-input"]')).toBeTruthy();
    expect(companyBinding!.querySelector('[data-testid="apex-scope-repo-input"]')).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it("adding a project id and saving calls scopeBindingApi.put with it in gcpProjects", async () => {
    const root = await renderSection(container);

    const companyBinding = container.querySelector('[data-testid="apex-company-scope-binding"]') as HTMLElement;
    const input = companyBinding.querySelector('[data-testid="apex-scope-project-input"]') as HTMLInputElement;
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;

    await act(async () => {
      nativeSetter.call(input, "my-finpilot-prod");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flushReact();

    const addButton = companyBinding.querySelector(
      '[data-testid="apex-scope-project-add"]',
    ) as HTMLButtonElement;
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(companyBinding.textContent).toContain("my-finpilot-prod");

    const saveButton = Array.from(companyBinding.querySelectorAll("button")).find((b) =>
      b.textContent?.trim().startsWith("Save binding"),
    ) as HTMLButtonElement;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(scopeBindingApi.put).toHaveBeenCalledWith(
      "company",
      COMPANY.id,
      expect.objectContaining({ gcpProjects: expect.arrayContaining(["my-finpilot-prod"]) }),
    );

    await act(async () => {
      root.unmount();
    });
  });
});
