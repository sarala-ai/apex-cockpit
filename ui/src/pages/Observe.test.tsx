// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProjectInventory } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Observe } from "./Observe";

const mockObserveApi = vi.hoisted(() => ({
  fleet: vi.fn(),
  runs: vi.fn(),
  health: vi.fn(),
  evals: vi.fn(),
  regressions: vi.fn(),
  gcpResource: vi.fn(),
  gcpInventory: vi.fn(),
  gcpServices: vi.fn(),
  gatewayMetrics: vi.fn(),
}));

vi.mock("@/api/observe", () => ({ observeApi: mockObserveApi }));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
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

function baseInventory(overrides: Partial<ProjectInventory> = {}): ProjectInventory {
  return {
    projectId: "proj-1",
    totalResources: 3,
    resourceTypes: 1,
    resourcesByType: {
      "run.googleapis.com/Service": [
        { name: "svc-labeled", displayName: "svc-labeled", attribution: { status: "label", workflow: "deploy--v1" } },
        { name: "svc-registry", displayName: "svc-registry", attribution: { status: "registry" } },
        { name: "svc-exception", displayName: "svc-exception", attribution: { status: "exception" } },
      ],
    },
    ...overrides,
  };
}

describe("Observe — GCP Inventory attribution", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    mockObserveApi.fleet.mockResolvedValue([]);
    mockObserveApi.runs.mockResolvedValue([]);
    mockObserveApi.health.mockResolvedValue(null);
    mockObserveApi.evals.mockResolvedValue([]);
    mockObserveApi.regressions.mockResolvedValue([]);
    mockObserveApi.gcpResource.mockResolvedValue({ health: null, logs: [], runs: [] });
    mockObserveApi.gcpServices.mockResolvedValue([]);
    mockObserveApi.gatewayMetrics.mockResolvedValue({});
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
          <Observe />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("renders exactly as today when attribution_summary is absent (older apex-core)", async () => {
    mockObserveApi.gcpInventory.mockResolvedValue([
      baseInventory({ attributionSummary: undefined }),
    ]);

    const root = await render();

    expect(container.textContent).toContain("3 resources · 1 types");
    expect(container.textContent).not.toContain("by label");
    expect(container.textContent).not.toContain("by registry");
    expect(container.textContent).not.toContain("exceptions");
    expect(container.textContent).not.toContain("unexplained resource");

    await act(async () => root.unmount());
  });

  it("renders attribution counts and an expandable exception list when attribution_summary is present", async () => {
    mockObserveApi.gcpInventory.mockResolvedValue([
      baseInventory({ attributionSummary: { label: 1, registry: 1, exception: 1 } }),
    ]);

    const root = await render();

    expect(container.textContent).toContain("1 by label");
    expect(container.textContent).toContain("1 by registry");
    expect(container.textContent).toContain("1 exceptions");
    expect(container.textContent).toContain("1 unexplained resource");
    expect(container.textContent).not.toContain("svc-exception");

    const toggle = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("unexplained resource"),
    ) as HTMLButtonElement | undefined;
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(container.textContent).toContain("svc-exception");
    expect(container.textContent).not.toContain("svc-labeled");

    await act(async () => root.unmount());
  });
});
