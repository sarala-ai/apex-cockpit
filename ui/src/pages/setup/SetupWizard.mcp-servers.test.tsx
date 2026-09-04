// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServersStep } from "./SetupWizard";
import { setupStateApi, type SetupState } from "../../api/apex-setup-state";

vi.mock("../../api/apex-setup-state", async () => {
  const actual = await vi.importActual<typeof import("../../api/apex-setup-state")>("../../api/apex-setup-state");
  return { ...actual, setupStateApi: { ...actual.setupStateApi, registerCockpitMcp: vi.fn() } };
});

function mcpServersState(overrides: Partial<SetupState["mcpServers"]> = {}): SetupState["mcpServers"] {
  return { registered: [], cockpitMcp: { registered: false }, ...overrides };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderStep(
  container: HTMLDivElement,
  mcpServers: SetupState["mcpServers"],
  opts: { done?: boolean; onRecheck?: () => void } = {},
): Promise<Root> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  const state = { mcpServers } as unknown as SetupState;
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <McpServersStep
          state={state}
          done={opts.done ?? false}
          onRecheck={opts.onRecheck ?? (() => {})}
          rechecking={false}
        />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  return root;
}

function click(el: Element | null) {
  expect(el).toBeTruthy();
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
    vi.restoreAllMocks();
  });

  it("hides the Register now button when cockpit-mcp is registered and there's no error", async () => {
    const root = await renderStep(container, mcpServersState({ registered: ["cockpit-mcp"], cockpitMcp: { registered: true, url: "http://cp/mcp" } }));
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent?.trim());
    expect(buttons).not.toContain("Register now");
    await act(async () => { root.unmount(); });
  });

  it("shows the Register now button when the registry read errored", async () => {
    const root = await renderStep(container, mcpServersState({ error: "apex-gateway rejected the credential (401)" }));
    const registerButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Register now");
    expect(registerButton).toBeTruthy();
    expect(container.textContent).toContain("Registry could not be read");
    await act(async () => { root.unmount(); });
  });

  it("shows the Register now button when cockpit-mcp is absent from the registry", async () => {
    const root = await renderStep(container, mcpServersState({ registered: ["gworkspace"], cockpitMcp: { registered: false } }));
    const registerButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Register now");
    expect(registerButton).toBeTruthy();
    await act(async () => { root.unmount(); });
  });

  it("calls registerCockpitMcp, invalidates, and shows the classified outcome on click", async () => {
    const registerCockpitMcp = setupStateApi.registerCockpitMcp as unknown as ReturnType<typeof vi.fn>;
    registerCockpitMcp.mockResolvedValue({ outcome: "gateway_unreachable", mcpUrl: "http://cp/mcp", message: "apex-gateway is unreachable" });
    const onRecheck = vi.fn();

    const root = await renderStep(container, mcpServersState({ cockpitMcp: { registered: false } }), { onRecheck });

    const registerButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Register now");
    click(registerButton ?? null);
    await flushReact();

    expect(registerCockpitMcp).toHaveBeenCalledTimes(1);
    expect(onRecheck).toHaveBeenCalled();
    expect(container.textContent).toContain("gateway_unreachable");
    expect(container.textContent).toContain("apex-gateway is unreachable");

    await act(async () => { root.unmount(); });
  });
});
