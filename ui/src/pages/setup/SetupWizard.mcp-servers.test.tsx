// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServersStep } from "./SetupWizard";
import type { SetupState } from "../../api/apex-setup-state";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

function mcpServersState(overrides: Partial<SetupState["mcpServers"]> = {}): SetupState["mcpServers"] {
  return {
    registered: [],
    probedAt: null,
    reachableCount: 0,
    details: [],
    cockpitMcp: { registered: false, reachable: null },
    ...overrides,
  };
}

async function renderStep(container: HTMLDivElement, mcpServers: SetupState["mcpServers"]): Promise<Root> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const state = { mcpServers } as unknown as SetupState;
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <McpServersStep state={state} done={false} onRecheck={() => {}} rechecking={false} />
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("McpServersStep", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      container.remove();
    });
    document.body.innerHTML = "";
  });

  it("is quiet when cockpit-mcp is registered and reachable", async () => {
    const root = await renderStep(container, mcpServersState({ registered: ["cockpit-mcp"], cockpitMcp: { registered: true, reachable: true, url: "http://cp/mcp" } }));
    expect(container.textContent).not.toContain("COCKPIT_PUBLIC_URL");
    expect(container.textContent).not.toContain("unreachable");
    expect(Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim())).not.toContain("Register now");
    await act(async () => { root.unmount(); });
  });

  it("names the gateway's COCKPIT_PUBLIC_URL when cockpit-mcp is absent from the registry", async () => {
    const root = await renderStep(container, mcpServersState({ registered: ["gworkspace"] }));
    expect(container.textContent).toContain("cockpit-mcp is not in the gateway registry");
    expect(container.textContent).toContain("COCKPIT_PUBLIC_URL");
    await act(async () => { root.unmount(); });
  });

  it("reports the gateway's unreachable verdict for a registered cockpit-mcp", async () => {
    const root = await renderStep(container, mcpServersState({ registered: ["cockpit-mcp"], cockpitMcp: { registered: true, reachable: false, url: "http://cp/mcp" } }));
    expect(container.textContent).toContain("gateway reports it unreachable");
    expect(container.textContent).toContain("http://cp/mcp");
    await act(async () => { root.unmount(); });
  });

  it("shows the registry read error instead of pretending the registry is empty", async () => {
    const root = await renderStep(container, mcpServersState({ error: "apex-gateway rejected the credential (401)" }));
    expect(container.textContent).toContain("Registry could not be read");
    expect(container.textContent).not.toContain("COCKPIT_PUBLIC_URL");
    await act(async () => { root.unmount(); });
  });

  // Regression for the "MCP servers registered — done" false positive: two rows
  // REGISTERED (enabled in the registry) while BOTH answer unreachable at the
  // last probe must never read as quietly fine — the per-upstream breakdown and
  // the probe time must both be visible.
  it("shows a per-upstream reachability breakdown and flags every unreachable registered upstream", async () => {
    const root = await renderStep(
      container,
      mcpServersState({
        registered: ["cockpit-mcp", "github-mcp"],
        reachableCount: 0,
        probedAt: "2026-09-05T00:00:00.000Z",
        details: [
          { name: "cockpit-mcp", enabled: true, reachable: false },
          { name: "github-mcp", enabled: true, reachable: false },
        ],
        cockpitMcp: { registered: true, reachable: false, url: "http://cp/mcp" },
      }),
    );
    expect(container.textContent).toContain("0/2 upstreams reachable");
    expect(container.textContent).toContain("cockpit-mcp");
    expect(container.textContent).toContain("github-mcp");
    expect(container.textContent).toContain("2 of 2 registered upstreams unreachable at the last probe");
    const link = container.querySelector('a[href="/gateway"]');
    expect(link).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("shows a quiet, fully-reachable breakdown without any unreachable callout", async () => {
    const root = await renderStep(
      container,
      mcpServersState({
        registered: ["cockpit-mcp", "gworkspace"],
        reachableCount: 2,
        probedAt: "2026-09-05T00:00:00.000Z",
        details: [
          { name: "cockpit-mcp", enabled: true, reachable: true },
          { name: "gworkspace", enabled: true, reachable: true },
        ],
        cockpitMcp: { registered: true, reachable: true, url: "http://cp/mcp" },
      }),
    );
    expect(container.textContent).toContain("2/2 upstreams reachable");
    expect(container.querySelector('a[href="/gateway"]')).toBeNull();
    await act(async () => { root.unmount(); });
  });
});
