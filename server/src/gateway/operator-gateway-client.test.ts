import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gatewayClientForRequest,
  gatewayClientForUser,
  mintOperatorTokenFor,
  operatorUserId,
  registerOperatorTokenMinters,
} from "./operator-gateway-client.js";

function reqWith(actor: unknown): Request {
  return { actor } as unknown as Request;
}

/** The bearer a client sends, read off the fetch it makes. */
async function bearerSentBy(client: { reachable(): Promise<boolean> }): Promise<string | null> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  await client.reachable();
  const init = fetchSpy.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.authorization ?? null;
}

afterEach(() => {
  registerOperatorTokenMinters({});
  vi.restoreAllMocks();
  delete process.env.APEX_GATEWAY_TOKEN;
});

describe("operatorUserId", () => {
  it("is the board actor's user", () => {
    expect(operatorUserId(reqWith({ type: "board", userId: "u1" }))).toBe("u1");
  });
  it("is the person an agent run is attributed to", () => {
    expect(operatorUserId(reqWith({ type: "agent", agentId: "a1", onBehalfOfUserId: "u2" }))).toBe("u2");
  });
  it("is null for an unattributed agent or no actor", () => {
    expect(operatorUserId(reqWith({ type: "agent", agentId: "a1" }))).toBeNull();
    expect(operatorUserId(reqWith(undefined))).toBeNull();
  });
});

describe("gatewayClientForRequest", () => {
  it("sends the operator's minted token when the request acts for a person", async () => {
    const mint = vi.fn(async () => "operator-jwt");
    registerOperatorTokenMinters({ forRequest: mint });
    const req = reqWith({ type: "board", userId: "u1" });
    expect(await bearerSentBy(gatewayClientForRequest(req))).toBe("Bearer operator-jwt");
    expect(mint).toHaveBeenCalledWith(req);
  });

  it("falls back to the env token when no minter is registered (local_trusted)", async () => {
    process.env.APEX_GATEWAY_TOKEN = "local-token";
    expect(await bearerSentBy(gatewayClientForRequest(reqWith({ type: "board", userId: "u1" })))).toBe("Bearer local-token");
  });

  it("never answers as the env token for a person whose token could not be minted", async () => {
    process.env.APEX_GATEWAY_TOKEN = "local-token";
    registerOperatorTokenMinters({ forRequest: async () => null });
    const probe = await gatewayClientForRequest(reqWith({ type: "board", userId: "u1" })).probe();
    expect(probe.failure?.kind).toBe("credential_unavailable");
  });

  it("uses an explicitly passed minter over the registered one", async () => {
    registerOperatorTokenMinters({ forRequest: async () => "registered" });
    const client = gatewayClientForRequest(reqWith({ type: "board", userId: "u1" }), async () => "explicit");
    expect(await bearerSentBy(client)).toBe("Bearer explicit");
  });
});

describe("gatewayClientForUser", () => {
  it("mints for the given user id", async () => {
    const mint = vi.fn(async (userId: string) => `jwt-for-${userId}`);
    registerOperatorTokenMinters({ forUser: mint });
    expect(await bearerSentBy(gatewayClientForUser("u9"))).toBe("Bearer jwt-for-u9");
  });
});

describe("mintOperatorTokenFor", () => {
  it("is null when the request acts for nobody, without calling the minter", async () => {
    const mint = vi.fn(async () => "x");
    registerOperatorTokenMinters({ forRequest: mint });
    expect(await mintOperatorTokenFor(reqWith({ type: "agent", agentId: "a1" }))).toBeNull();
    expect(mint).not.toHaveBeenCalled();
  });
});
