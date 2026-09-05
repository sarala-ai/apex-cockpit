/**
 * The registration sweep exists because boot-time registration (app.ts)
 * runs exactly once — this covers the retry-then-stop-once-verified shape,
 * and that it resumes if the registry later loses the entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayWriteResult } from "../gateway/gateway-client.js";
import type { GatewayEntry } from "@paperclipai/shared";
import { startCockpitMcpRegistrationSweep, cockpitMcpRegistrationSweep, federationCredentialPolicy } from "../mcp/registration-sweep.js";
import { resetCockpitMcpRegistrationAttemptForTests, getLastCockpitMcpRegistrationAttempt } from "../mcp/registration-state.js";

const cockpitMcpEntry = (overrides: Partial<GatewayEntry> = {}): GatewayEntry => ({
  id: "g1",
  name: "cockpit-mcp",
  url: "http://127.0.0.1:3100/mcp",
  transport: "STREAMABLEHTTP",
  description: null,
  enabled: true,
  reachable: true,
  authType: null,
  createdAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  resetCockpitMcpRegistrationAttemptForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("cockpitMcpRegistrationSweep", () => {
  it("attempts registration when the registry has no cockpit-mcp entry, and records the attempt", async () => {
    const readGateways = vi.fn(async () => ({ ok: true as const, value: [] }));
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    const job = cockpitMcpRegistrationSweep(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      { client: { readGateways, registerGateway } as unknown as GatewayClient, log: () => {} },
    );

    const result = await job.sweep();
    expect(result.attempted).toBe(true);
    expect(result.result?.outcome).toBe("registered");
    expect(registerGateway).toHaveBeenCalledTimes(1);
    expect(getLastCockpitMcpRegistrationAttempt()?.outcome).toBe("registered");
  });

  it("does not attempt when the registry already confirms cockpit-mcp registered + reachable", async () => {
    const readGateways = vi.fn(async () => ({ ok: true as const, value: [cockpitMcpEntry()] }));
    const registerGateway = vi.fn();
    const job = cockpitMcpRegistrationSweep(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      { client: { readGateways, registerGateway } as unknown as GatewayClient, log: () => {} },
    );

    const result = await job.sweep();
    expect(result.attempted).toBe(false);
    expect(registerGateway).not.toHaveBeenCalled();
  });

  it("still attempts when cockpit-mcp is present but not reachable", async () => {
    const readGateways = vi.fn(async () => ({ ok: true as const, value: [cockpitMcpEntry({ reachable: false })] }));
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    const job = cockpitMcpRegistrationSweep(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      { client: { readGateways, registerGateway } as unknown as GatewayClient, log: () => {} },
    );

    const result = await job.sweep();
    expect(result.attempted).toBe(true);
  });
});

describe("startCockpitMcpRegistrationSweep", () => {
  it("retries on every tick while unregistered, then stops attempting once the registry confirms registration", async () => {
    let registered = false;
    const readGateways = vi.fn(async () => ({ ok: true as const, value: registered ? [cockpitMcpEntry()] : [] }));
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => {
      registered = true;
      return { ok: true, id: "g1", name: "cockpit-mcp" };
    });

    const stop = startCockpitMcpRegistrationSweep(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      {
        client: { readGateways, registerGateway } as unknown as GatewayClient,
        log: () => {},
        intervalMs: 5000,
      },
    );

    // initialDelayMs = min(intervalMs, 30_000) = 5000 here.
    await vi.advanceTimersByTimeAsync(5000);
    expect(registerGateway).toHaveBeenCalledTimes(1);

    // Now registered — subsequent ticks read the registry but do not re-register.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(registerGateway).toHaveBeenCalledTimes(1);
    expect(readGateways.mock.calls.length).toBeGreaterThanOrEqual(3);

    stop();
  });

  it("resumes attempting if the registry later loses the cockpit-mcp entry", async () => {
    let entries: GatewayEntry[] = [cockpitMcpEntry()];
    const readGateways = vi.fn(async () => ({ ok: true as const, value: entries }));
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => {
      entries = [cockpitMcpEntry()];
      return { ok: true, id: "g1", name: "cockpit-mcp" };
    });

    const stop = startCockpitMcpRegistrationSweep(
      { serverPort: 3100, deploymentMode: "local_trusted", publicUrl: null },
      {
        client: { readGateways, registerGateway } as unknown as GatewayClient,
        log: () => {},
        intervalMs: 5000,
      },
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(registerGateway).not.toHaveBeenCalled(); // already registered on first tick

    entries = []; // the gateway's own state was reset
    await vi.advanceTimersByTimeAsync(5000);
    expect(registerGateway).toHaveBeenCalledTimes(1); // resumed

    stop();
  });
});

function fakeFederationJwt(expSec: number): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "EdDSA", kid: "k1" })}.${b64({ sub: "apex-gateway", iss: "https://cockpit.run.app", exp: expSec })}.sig`;
}

describe("cockpitMcpRegistrationSweep — federation credential refresh", () => {
  const INTERVAL = 300_000;
  const input = { serverPort: 3100, deploymentMode: "authenticated" as const, publicUrl: "https://cockpit.run.app" };

  function harness(startMs: number) {
    let now = startMs;
    const policy = federationCredentialPolicy(INTERVAL);
    // Mints like the wired source: lifetime = 3 × interval + margin.
    const federationToken = vi.fn(async () => fakeFederationJwt(Math.floor(now / 1000) + policy.lifetimeSeconds));
    const readGateways = vi.fn(async () => ({ ok: true as const, value: [cockpitMcpEntry({ url: "https://cockpit.run.app/mcp" })] }));
    const registerGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: false, status: "conflict", message: "exists" }));
    const updateGateway = vi.fn(async (): Promise<GatewayWriteResult> => ({ ok: true, id: "g1", name: "cockpit-mcp" }));
    const job = cockpitMcpRegistrationSweep(
      input,
      { client: { readGateways, registerGateway, updateGateway } as unknown as GatewayClient, federationToken, log: () => {}, now: () => now },
      INTERVAL,
    );
    return { job, updateGateway, federationToken, advance: (ms: number) => { now += ms; } };
  }

  it("a fresh process refreshes on its first tick, leaves the credential alone while it outlives two intervals, then refreshes again", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const h = harness(1_700_000_000_000);

    const first = await h.job.sweep();
    expect(first.attempted).toBe(true);
    expect(first.result?.outcome).toBe("credential_refreshed");
    expect(h.updateGateway).toHaveBeenCalledTimes(1);

    h.advance(INTERVAL); // remaining 2I + margin → not due
    expect((await h.job.sweep()).attempted).toBe(false);
    expect(h.updateGateway).toHaveBeenCalledTimes(1);

    h.advance(INTERVAL); // remaining I + margin < 2I → due
    const third = await h.job.sweep();
    expect(third.attempted).toBe(true);
    expect(third.result?.outcome).toBe("credential_refreshed");
    expect(h.updateGateway).toHaveBeenCalledTimes(2);
  });

  it("does not touch a registration when no token source is in play", async () => {
    vi.stubEnv("PAPERCLIP_COCKPIT_MCP_URL", "");
    const readGateways = vi.fn(async () => ({ ok: true as const, value: [cockpitMcpEntry({ url: "https://cockpit.run.app/mcp" })] }));
    const updateGateway = vi.fn();
    const job = cockpitMcpRegistrationSweep(
      input,
      { client: { readGateways, updateGateway } as unknown as GatewayClient, federationToken: async () => null, log: () => {} },
      INTERVAL,
    );
    expect((await job.sweep()).attempted).toBe(false);
    expect((await job.sweep()).attempted).toBe(false);
    expect(updateGateway).not.toHaveBeenCalled();
  });

  it("derives lifetime and refresh from one interval so a single missed tick is survivable", () => {
    const policy = federationCredentialPolicy(INTERVAL);
    expect(policy.lifetimeSeconds * 1000).toBe(3 * INTERVAL + 60_000);
    expect(policy.refreshBelowMs).toBe(2 * INTERVAL);
    expect(policy.tokenSourceRefreshMarginMs).toBe(2 * INTERVAL);
    // Written at tick 0, still valid at tick 3 even if tick 2's refresh failed.
    expect(policy.lifetimeSeconds * 1000 - 3 * INTERVAL).toBeGreaterThan(0);
  });
});
