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

function fakeFederationJwt(payload: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "EdDSA", kid: "k1" })}.${b64(payload)}.sig`;
}

describe("registerCockpitMcpWithGateway — gateway-federation credential", () => {
  const entry = (url: string) => ({ id: "g1", name: "cockpit-mcp", url, transport: "STREAMABLEHTTP", description: null, enabled: true, reachable: true, authType: null, createdAt: null });

  it("registers the federation token as the stored bearer, pinned to its issuer with login passthrough", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const exp = Math.floor(Date.now() / 1000) + 960;
    const token = fakeFederationJwt({ sub: "apex-gateway", iss: "https://cockpit.run.app", exp });
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://cockpit.run.app" },
      { registerGateway } as unknown as GatewayClient,
      { federationToken: async () => token },
    );
    expect(registerGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: "bearer",
        authToken: token,
        oauthConfig: { login_passthrough: true, issuer: "https://cockpit.run.app" },
      }),
    );
    expect(result).toMatchObject({ outcome: "registered", credentialExpiresAt: exp * 1000 });
  });

  it("omits the issuer pin for a loopback issuer, which the gateway's URL validator refuses", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const token = fakeFederationJwt({ sub: "apex-gateway", iss: "http://localhost:3100", exp: Math.floor(Date.now() / 1000) + 960 });
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: null },
      { registerGateway } as unknown as GatewayClient,
      { federationToken: async () => token },
    );
    expect(registerGateway.mock.calls[0]![0]).toMatchObject({ oauthConfig: { login_passthrough: true } });
    expect((registerGateway.mock.calls[0]![0] as { oauthConfig: Record<string, unknown> }).oauthConfig.issuer).toBeUndefined();
  });

  it("sends no credential fields when the source yields none (local contract)", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      { registerGateway } as unknown as GatewayClient,
      { federationToken: async () => null },
    );
    const call = registerGateway.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.authType).toBeUndefined();
    expect(call.oauthConfig).toBeUndefined();
    expect(result.credentialExpiresAt).toBeUndefined();
  });

  it("on 409 at the current URL, refreshes the stored credential via PUT (default) unless told the credential is fresh", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const token = fakeFederationJwt({ sub: "apex-gateway", iss: "https://cockpit.run.app", exp: Math.floor(Date.now() / 1000) + 960 });
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: false, status: "conflict", message: "conflict" }));
    const readGateways = vi.fn(async () => ({ ok: true as const, value: [entry("https://cockpit.run.app/mcp")] }));
    const updateGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    const client = { registerGateway, readGateways, updateGateway } as unknown as GatewayClient;
    const input = { serverPort: 3100, deploymentMode: "authenticated" as const, publicUrl: "https://cockpit.run.app" };

    const refreshed = await registerCockpitMcpWithGateway(input, client, { federationToken: async () => token });
    expect(updateGateway).toHaveBeenCalledWith("g1", expect.objectContaining({ url: "https://cockpit.run.app/mcp", authType: "bearer", authToken: token }));
    expect(refreshed.outcome).toBe("credential_refreshed");
    expect(refreshed.credentialExpiresAt).toEqual(expect.any(Number));

    updateGateway.mockClear();
    const fresh = await registerCockpitMcpWithGateway(input, client, { federationToken: async () => token, refreshCredential: false });
    expect(updateGateway).not.toHaveBeenCalled();
    expect(fresh.outcome).toBe("already_registered");
  });

  it("a mint failure is a retryable outcome, never an unauthenticated registration", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const registerGateway = vi.fn();
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://cockpit.run.app" },
      { registerGateway } as unknown as GatewayClient,
      { federationToken: async () => { throw new Error("signer down"); } },
    );
    expect(registerGateway).not.toHaveBeenCalled();
    expect(result.outcome).toBe("gateway_unreachable");
    expect(result.message).toMatch(/signer down/);
  });

  it("with a credential registered, an upstream refusal is named as a verification failure, not a missing credential", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const token = fakeFederationJwt({ sub: "apex-gateway", iss: "https://cockpit.run.app", exp: Math.floor(Date.now() / 1000) + 960 });
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: false, status: "upstream_unreachable", message: "502" }));
    const result = await registerCockpitMcpWithGateway(
      { serverPort: 3100, deploymentMode: "authenticated", publicUrl: "https://cockpit.run.app" },
      { registerGateway } as unknown as GatewayClient,
      { federationToken: async () => token },
    );
    expect(result.outcome).toBe("upstream_auth_required");
    expect(result.message).toMatch(/verification failure/);
  });
});
