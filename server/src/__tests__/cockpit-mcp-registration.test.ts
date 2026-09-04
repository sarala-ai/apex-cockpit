import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayWriteResult } from "../gateway/gateway-client.js";
import { registerCockpitMcpWithGateway, resolveCockpitMcpUrl } from "../mcp/router.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveCockpitMcpUrl", () => {
  it("uses loopback on a local instance", () => {
    expect(resolveCockpitMcpUrl({ serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null })).toBe(
      "http://127.0.0.1:3100/mcp",
    );
  });

  it("derives the public MCP URL on a hosted instance", () => {
    expect(
      resolveCockpitMcpUrl({ serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://cockpit.run.app/" }),
    ).toBe("https://cockpit.run.app/mcp");
  });

  it("stays on loopback when authenticated without a public URL", () => {
    expect(resolveCockpitMcpUrl({ serverPort: 3100, deploymentMode: "authenticated", publicUrl: null })).toBe(
      "http://127.0.0.1:3100/mcp",
    );
  });

  it("lets an explicit URL win", () => {
    expect(
      resolveCockpitMcpUrl({
        serverPort: 3100,
        deploymentMode: "authenticated",
        publicUrl: "https://cockpit.run.app",
        explicitUrl: " https://custom/mcp ",
      }),
    ).toBe("https://custom/mcp");
  });
});

describe("registerCockpitMcpWithGateway", () => {
  it("registers the public URL on a hosted instance through the injected client, with a raised timeout", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://cockpit.run.app" },
      { registerGateway } as unknown as GatewayClient,
    );
    expect(registerGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "cockpit-mcp",
        url: "https://cockpit.run.app/mcp",
        transport: "STREAMABLEHTTP",
        timeoutMs: expect.any(Number),
      }),
    );
    // The whole point of the raised timeout is to outlast the gateway's own
    // ~120s upstream-initialize ceiling (federation_timeout) — the previous
    // 8s default (gateway-client.ts timedWrite) was far shorter than that.
    const [call] = registerGateway.mock.calls[0] as [{ timeoutMs: number }];
    expect(call.timeoutMs).toBeGreaterThan(120_000);
    expect(result).toEqual({ outcome: "registered", mcpUrl: "https://cockpit.run.app/mcp", message: "registered with APEX gateway (id=g1)" });
  });

  it("classifies a rejected credential distinctly from an unreachable gateway, and never says 'non-fatal'", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: false, status: "auth", message: "rejected (403)" }));
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      { registerGateway } as unknown as GatewayClient,
    );
    expect(result.outcome).toBe("rejected_credential");
    expect(result.message).not.toMatch(/non-fatal/i);
  });

  it("skips registration when the public URL is still the deploy placeholder", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn();
    const readGateways = vi.fn();
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://placeholder.invalid" },
      { registerGateway, readGateways } as unknown as GatewayClient,
    );
    expect(registerGateway).not.toHaveBeenCalled();
    expect(readGateways).not.toHaveBeenCalled();
    expect(result.outcome).toBe("skipped_placeholder");
  });

  it("on 409 with the same registered URL, does not update", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: false, status: "conflict", message: "conflict" }));
    const readGateways = vi.fn(async () => ({
      ok: true as const,
      value: [{ id: "g1", name: "cockpit-mcp", url: "https://cockpit.run.app/mcp", transport: "STREAMABLEHTTP", description: null, enabled: true, reachable: true, authType: null, createdAt: null }],
    }));
    const updateGateway = vi.fn();
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://cockpit.run.app" },
      { registerGateway, readGateways, updateGateway } as unknown as GatewayClient,
    );
    expect(readGateways).toHaveBeenCalled();
    expect(updateGateway).not.toHaveBeenCalled();
    expect(result.outcome).toBe("already_registered");
  });

  it("on 409 with a different registered URL, repoints it with the same raised timeout", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: false, status: "conflict", message: "conflict" }));
    const readGateways = vi.fn(async () => ({
      ok: true as const,
      value: [{ id: "g1", name: "cockpit-mcp", url: "https://placeholder.invalid/mcp", transport: "STREAMABLEHTTP", description: null, enabled: true, reachable: true, authType: null, createdAt: null }],
    }));
    const updateGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://cockpit.run.app" },
      { registerGateway, readGateways, updateGateway } as unknown as GatewayClient,
    );
    expect(updateGateway).toHaveBeenCalledWith("g1", { url: "https://cockpit.run.app/mcp", timeoutMs: expect.any(Number) });
    expect(result.outcome).toBe("repointed");
  });

  it("classifies an upstream_unreachable failure as upstream_auth_required, naming the JWT gap instead of 'unreachable'", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(
      async (): Promise<GatewayWriteResult> => ({ ok: false, status: "upstream_unreachable", message: "502 from gateway" }),
    );
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      { registerGateway } as unknown as GatewayClient,
    );
    expect(result.outcome).toBe("upstream_auth_required");
    expect(result.message).toMatch(/JWT/);
    expect(result.message).not.toBe("apex-gateway is unreachable");
  });

  it("classifies a true transport failure as gateway_unreachable (the retryable case)", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(
      async (): Promise<GatewayWriteResult> => ({ ok: false, status: "unreachable", message: "apex-gateway is unreachable" }),
    );
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      { registerGateway } as unknown as GatewayClient,
    );
    expect(result.outcome).toBe("gateway_unreachable");
  });
});
