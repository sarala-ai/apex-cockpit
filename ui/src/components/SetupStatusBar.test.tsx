// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupStatusBar } from "./SetupStatusBar";
import { setupStateApi, type SetupState } from "../api/apex-setup-state";

let currentPath = "/dashboard";
const mockNavigate = vi.fn();

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: currentPath }),
  useNavigate: () => mockNavigate,
}));

vi.mock("../api/apex-setup-state", async () => {
  const actual = await vi.importActual<typeof import("../api/apex-setup-state")>("../api/apex-setup-state");
  return { ...actual, setupStateApi: { ...actual.setupStateApi, get: vi.fn() } };
});

function completeState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    auth: { gcloud: "ok", gh: "ok", adc: "ok", source: "server", reportedAt: null, reportAgeMs: null },
    org: { present: true, id: "org-1", posture: "individual" },
    membership: { present: true, role: "owner", status: "active" },
    companies: { count: 1, ids: ["c1"] },
    scoping: { orgProjectsBound: true, orgReposBound: true, companyProjectsBound: true, companyReposBound: true },
    oauthClient: { configured: true, signInClient: "configured", gatewayUpstreams: { total: 1, configured: 1 } },
    gateway: { reachable: true, url: "http://gw.test", authenticated: true, failure: null },
    mcpServers: {
      registered: ["cockpit-mcp", "github-mcp"],
      probedAt: "2026-09-05T00:00:00.000Z",
      reachableCount: 2,
      details: [
        { name: "cockpit-mcp", enabled: true, reachable: true },
        { name: "github-mcp", enabled: true, reachable: true },
      ],
      cockpitMcp: { registered: true, reachable: true, url: "http://cp/mcp" },
    },
    models: {
      claude: {
        mode: "subscription_local",
        installed: true,
        source: "server",
        reportedAt: null,
        subscriptionProviderRegistered: true,
        apiKeyProviderRegistered: false,
      },
      openrouter: { configured: false },
      aliasesRegistered: ["apex-judge-default"],
      bridgeAvailable: true,
    },
    claudeSession: { connected: true, source: "subscription_token", setAt: null },
    ...overrides,
  } as SetupState;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderBar(container: HTMLDivElement): Promise<Root> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <SetupStatusBar />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  return root;
}

describe("SetupStatusBar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    currentPath = "/dashboard";
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await act(async () => {
      container.remove();
    });
    document.body.innerHTML = "";
  });

  it("shows the MCP chip as reachable/registered — not just the registered count — and amber/red when unreachable", async () => {
    vi.mocked(setupStateApi.get).mockResolvedValue(
      completeState({
        mcpServers: {
          registered: ["cockpit-mcp", "github-mcp"],
          probedAt: "2026-09-05T00:00:00.000Z",
          reachableCount: 0,
          details: [
            { name: "cockpit-mcp", enabled: true, reachable: false },
            { name: "github-mcp", enabled: true, reachable: false },
          ],
          cockpitMcp: { registered: true, reachable: false, url: "http://cp/mcp" },
        },
      }),
    );

    const root = await renderBar(container);
    const chip = container.querySelector('[data-testid="setup-status-mcp"]');
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-tone")).toBe("bad");
    expect(chip?.textContent).toContain("0/2 reachable");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows the MCP chip green only when every registered upstream is reachable", async () => {
    vi.mocked(setupStateApi.get).mockResolvedValue(completeState());
    const root = await renderBar(container);
    const chip = container.querySelector('[data-testid="setup-status-mcp"]');
    expect(chip?.getAttribute("data-tone")).toBe("ok");
    expect(chip?.textContent).toContain("2/2 reachable");
    await act(async () => {
      root.unmount();
    });
  });

  it("derives the nudge toast from the actual pending step titles, and never shows it on /setup", async () => {
    const state = completeState();
    state.scoping = { ...state.scoping, orgProjectsBound: false };
    vi.mocked(setupStateApi.get).mockResolvedValue(state);

    currentPath = "/dashboard";
    const root = await renderBar(container);
    expect(container.textContent).toContain("Org cloud");
    expect(container.querySelector('[data-testid="setup-startup-prompt"]')).not.toBeNull();
    await act(async () => {
      root.unmount();
    });
  });

  it("never shows the startup prompt while already on /setup", async () => {
    const state = completeState();
    state.scoping = { ...state.scoping, orgProjectsBound: false };
    vi.mocked(setupStateApi.get).mockResolvedValue(state);

    currentPath = "/setup";
    const root = await renderBar(container);
    expect(container.querySelector('[data-testid="setup-startup-prompt"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
