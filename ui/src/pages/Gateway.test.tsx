// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Gateway } from "./Gateway";
import { ApiError } from "@/api/client";

const mockGatewayApi = vi.hoisted(() => ({
  registry: vi.fn(),
  agents: vi.fn(),
  audit: vi.fn(),
  register: vi.fn(),
}));

vi.mock("@/api/gateway", () => ({
  gatewayApi: mockGatewayApi,
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

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const EMPTY_REGISTRY = { gateways: [], tools: [], servers: [], error: null };

describe("Gateway registry — Add MCP server", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockGatewayApi.registry.mockResolvedValue(EMPTY_REGISTRY);
    mockGatewayApi.agents.mockResolvedValue([]);
    mockGatewayApi.audit.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderGateway() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Gateway />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  function clickButton(text: string) {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined;
    expect(button).toBeTruthy();
    return act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("submits the form, calls register, and refreshes the registry on success", async () => {
    mockGatewayApi.register.mockResolvedValue({ id: "gw-1", name: "penpot" });
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Gateway />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    await clickButton("Add MCP server");

    const nameInput = container.querySelector<HTMLInputElement>("#mcp-name");
    const urlInput = container.querySelector<HTMLInputElement>("#mcp-url");
    expect(nameInput).toBeTruthy();
    expect(urlInput).toBeTruthy();

    await act(async () => {
      setInputValue(nameInput!, "penpot");
      setInputValue(urlInput!, "https://penpot.example.com/mcp");
    });

    mockGatewayApi.registry.mockResolvedValue({
      gateways: [
        { id: "gw-1", name: "penpot", url: "https://penpot.example.com/mcp", transport: "STREAMABLEHTTP", description: null, enabled: true, reachable: true, createdAt: null },
      ],
      tools: [],
      servers: [],
      error: null,
    });

    await clickButton("Register");
    await flushReact();
    await flushReact();

    expect(mockGatewayApi.register).toHaveBeenCalledWith({
      name: "penpot",
      url: "https://penpot.example.com/mcp",
      transport: "STREAMABLEHTTP",
    });
    // Registry query was invalidated + refetched with the newly registered gateway.
    expect(mockGatewayApi.registry).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("penpot");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders the classified error message inline on failure, without closing the form", async () => {
    mockGatewayApi.register.mockRejectedValue(
      new ApiError(
        "url resolves to a private network address. apex-gateway blocks docker-internal/private-network hosts by default (SSRF guard).",
        422,
        null,
      ),
    );
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Gateway />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    await clickButton("Add MCP server");

    const nameInput = container.querySelector<HTMLInputElement>("#mcp-name");
    const urlInput = container.querySelector<HTMLInputElement>("#mcp-url");
    await act(async () => {
      setInputValue(nameInput!, "internal-tool");
      setInputValue(urlInput!, "http://localhost:9000/mcp");
    });

    await clickButton("Register");
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("SSRF guard");
    // Form stays open with the error visible — the "Register" button (not just
    // "Add MCP server") should still be present.
    expect(
      Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Register"),
    ).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
