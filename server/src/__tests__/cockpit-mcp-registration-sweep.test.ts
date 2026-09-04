/**
 * The registration sweep exists because boot-time registration (app.ts)
 * runs exactly once — this covers the retry-then-stop-once-verified shape,
 * and that it resumes if the registry later loses the entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayWriteResult } from "../gateway/gateway-client.js";
import type { GatewayEntry } from "@paperclipai/shared";
import { startCockpitMcpRegistrationSweep, cockpitMcpRegistrationSweep } from "../mcp/registration-sweep.js";
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
