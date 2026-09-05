// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServersStep } from "./SetupWizard";
import type { SetupState } from "../../api/apex-setup-state";

function mcpServersState(overrides: Partial<SetupState["mcpServers"]> = {}): SetupState["mcpServers"] {
  return { registered: [], cockpitMcp: { registered: false, reachable: null }, ...overrides };
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
});
