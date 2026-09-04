import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient, classifyStatus } from "./gateway-client.js";

type FetchCall = { url: string; headers: Record<string, string> };

function stubFetch(handler: (url: string) => Response | Error, calls: FetchCall[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const out = handler(url);
      if (out instanceof Error) throw out;
      return out;
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.stubEnv("APEX_GATEWAY_URL", "http://gw.test");
  vi.stubEnv("APEX_GATEWAY_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("classifyStatus", () => {
  it("separates credential rejection from other HTTP failures", () => {
    expect(classifyStatus(401).kind).toBe("unauthenticated");
    expect(classifyStatus(403, "CSRF validation failed")).toMatchObject({ kind: "forbidden", status: 403 });
    expect(classifyStatus(403, "CSRF validation failed").message).toContain("CSRF validation failed");
    expect(classifyStatus(500).kind).toBe("http");
  });
});

describe("GatewayClient credential", () => {
  it("sends the token a source mints, resolved per call", async () => {
    const calls = stubFetch(() => json(200, []));
    let n = 0;
    const client = new GatewayClient(async () => `tok-${++n}`);
    await client.listGateways();
    await client.listGateways();
    expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
  });

  it("falls back to APEX_GATEWAY_TOKEN when the source yields nothing, and sends no header without either", async () => {
    const calls = stubFetch(() => json(200, []));
    vi.stubEnv("APEX_GATEWAY_TOKEN", "env-tok");
    await new GatewayClient(async () => null).listGateways();
    expect(calls[0]!.headers.authorization).toBe("Bearer env-tok");
    vi.stubEnv("APEX_GATEWAY_TOKEN", "");
    await new GatewayClient().listGateways();
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });
});

describe("GatewayClient read classification", () => {
  it("reports a 401 as unauthenticated, not unreachable", async () => {
    stubFetch(() => json(401, { detail: "Authentication required" }));
    const client = new GatewayClient();
    const read = await client.readGateways();
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.failure.kind).toBe("unauthenticated");
      expect(read.failure.message).toContain("Authentication required");
    }
    expect(await client.listGateways()).toEqual([]);
    expect(await client.probe()).toMatchObject({ reachable: true, authenticated: false });
    expect(await client.reachable()).toBe(true);
  });

  it("reports a transport failure as unreachable", async () => {
    stubFetch(() => new Error("ECONNREFUSED"));
    const client = new GatewayClient();
    const read = await client.readGateways();
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure.kind).toBe("unreachable");
    expect(await client.probe()).toMatchObject({ reachable: false, authenticated: null });
    expect(await client.reachable()).toBe(false);
  });

  it("returns the registry names on success", async () => {
    stubFetch(() => json(200, [{ id: "g1", name: "cockpit-mcp", url: "https://c/mcp" }]));
    const read = await new GatewayClient().readGateways();
    expect(read.ok && read.value.map((g) => g.name)).toEqual(["cockpit-mcp"]);
  });

  it("metrics distinguishes credential rejection from an unreachable gateway", async () => {
    stubFetch(() => json(401, { detail: "Authentication required" }));
    const rejected = await new GatewayClient().metrics();
    expect(rejected.reachable).toBe(true);
    expect(rejected.error).toMatch(/401/);

    stubFetch(() => new Error("timeout"));
    const down = await new GatewayClient().metrics();
    expect(down.reachable).toBe(false);
    expect(down.error).toMatch(/unreachable/);
  });
});

describe("GatewayClient write classification", () => {
  it("classifies the gateway's CSRF rejection of a tokenless write as an auth failure", async () => {
    stubFetch(() => json(403, { message: "CSRF validation failed" }));
    const result = await new GatewayClient().registerGateway({ name: "x", url: "https://x/mcp", transport: "STREAMABLEHTTP" });
    expect(result).toMatchObject({ ok: false, status: "auth" });
    if (!result.ok) expect(result.message).toContain("CSRF validation failed");
  });

  it("classifies 401 on a delete as an auth failure", async () => {
    stubFetch(() => json(401, { detail: "Authentication required" }));
    const result = await new GatewayClient().deleteGateway("g1");
    expect(result).toMatchObject({ ok: false, status: "auth" });
  });
});
