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
  it("registers the public URL on a hosted instance through the injected client", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://cockpit.run.app" },
      { registerGateway } as unknown as GatewayClient,
    );
    expect(registerGateway).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cockpit-mcp", url: "https://cockpit.run.app/mcp", transport: "STREAMABLEHTTP" }),
    );
  });

  it("does not throw when the gateway rejects the credential", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: false, status: "auth", message: "rejected (403)" }));
    await expect(
      registerCockpitMcpWithGateway(
        { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
        { registerGateway } as unknown as GatewayClient,
      ),
    ).resolves.toBeUndefined();
  });
});
