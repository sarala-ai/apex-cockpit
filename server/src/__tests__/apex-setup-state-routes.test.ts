import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { apexSetupStateRoutes, defaultProbes, type SetupStateProbes } from "../routes/apex-setup-state.js";
import type { GatewayClient } from "../gateway/gateway-client.js";
import { errorHandler } from "../middleware/index.js";

const healthy: SetupStateProbes = {
  auth: async () => ({ gcloud: "ok", gh: "ok", adc: "ok", source: "server", reportedAt: null }),
  org: async () => ({ present: true, id: "org-1", posture: "individual" }),
  membership: async () => ({ present: true, role: "owner", status: "active" }),
  companies: async () => ({ count: 2, ids: ["c1", "c2"] }),
  scoping: async () => ({
    orgProjectsBound: true,
    orgReposBound: true,
    companyProjectsBound: true,
    companyReposBound: true,
  }),
  orgGithub: async () => ({ appInstalled: true, wifConfigured: true }),
  oauthClient: async () => ({ configured: true }),
  gateway: async () => ({ reachable: true }),
  mcpServers: async () => ({ registered: ["gworkspace"] }),
};

function appWith(overrides: Partial<SetupStateProbes>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "agent", agentId: "a1" };
    next();
  });
  // Dummy db — all probes are overridden, so it's never touched.
  app.use(apexSetupStateRoutes({} as unknown as Db, { ...healthy, ...overrides }));
  app.use(errorHandler);
  return app;
}

describe("GET /setup/state", () => {
  it("returns the full assembled snapshot when every probe succeeds", async () => {
    const res = await request(
      appWith({
        models: async () => ({
          claude: { mode: "none", installed: false, subscriptionProviderRegistered: false, apiKeyProviderRegistered: false },
          openrouter: { configured: false },
          aliasesRegistered: [],
        }),
      }),
    ).get("/setup/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      auth: { gcloud: "ok", gh: "ok", adc: "ok", source: "server", reportedAt: null },
      claudeSession: { connected: false, source: null, setAt: null },
      org: { present: true, id: "org-1", posture: "individual" },
      membership: { present: true, role: "owner", status: "active" },
      companies: { count: 2, ids: ["c1", "c2"] },
      scoping: {
        orgProjectsBound: true,
        orgReposBound: true,
        companyProjectsBound: true,
        companyReposBound: true,
      },
      orgGithub: { appInstalled: true, wifConfigured: true },
      oauthClient: { configured: true },
      gateway: { reachable: true },
      mcpServers: { registered: ["gworkspace"] },
      models: {
        claude: { mode: "none", installed: false, subscriptionProviderRegistered: false, apiKeyProviderRegistered: false },
        openrouter: { configured: false },
        aliasesRegistered: [],
      },
    });
  });

  it("degrades gracefully — a throwing probe falls back, endpoint stays 200", async () => {
    const res = await request(
      appWith({
        auth: async () => {
          throw new Error("gcloud gone");
        },
        gateway: async () => {
          throw new Error("gateway down");
        },
        mcpServers: async () => {
          throw new Error("no gateway");
        },
      }),
    ).get("/setup/state");
    expect(res.status).toBe(200);
    expect(res.body.auth).toEqual({ gcloud: "missing", gh: "missing", adc: "missing", source: "none", reportedAt: null });
    expect(res.body.gateway).toEqual({ reachable: false });
    expect(res.body.mcpServers).toEqual({ registered: [] });
    // Unaffected probes still report their real values.
    expect(res.body.org).toEqual({ present: true, id: "org-1", posture: "individual" });
  });

  it("scopes companies to ?orgId when provided", async () => {
    let seen: string | undefined = "UNSET";
    await request(
      appWith({
        org: async () => ({ present: false }),
        companies: async (orgId) => {
          seen = orgId;
          return { count: 0, ids: [] };
        },
      }),
    ).get("/setup/state?orgId=org-xyz");
    expect(seen).toBe("org-xyz");
  });
});

describe("defaultProbes gateway probes", () => {
  const fakeGateway = (readGateways: () => Promise<unknown>, reachable = async () => true) =>
    ({ readGateways, reachable }) as unknown as GatewayClient;

  it("lists the registry names when the credential is accepted", async () => {
    const probes = defaultProbes({} as unknown as Db, fakeGateway(async () => ({ ok: true, value: [{ name: "cockpit-mcp" }, { name: "gworkspace" }] })));
    expect(await probes.mcpServers(true)).toEqual({ registered: ["cockpit-mcp", "gworkspace"] });
  });

  it("carries the auth failure instead of reporting an empty registry", async () => {
    const probes = defaultProbes(
      {} as unknown as Db,
      fakeGateway(async () => ({ ok: false, failure: { kind: "unauthenticated", status: 401, message: "apex-gateway rejected the credential (401)" } })),
    );
    expect(await probes.mcpServers(true)).toEqual({ registered: [], error: "apex-gateway rejected the credential (401)" });
  });

  it("skips the registry read when the gateway is down", async () => {
    let called = false;
    const probes = defaultProbes({} as unknown as Db, fakeGateway(async () => { called = true; return { ok: true, value: [] }; }));
    expect(await probes.mcpServers(false)).toEqual({ registered: [] });
    expect(called).toBe(false);
  });

  it("passes the registry error through the route", async () => {
    const res = await request(
      appWith({
        mcpServers: async () => ({ registered: [], error: "apex-gateway rejected the credential (401)" }),
        models: async () => ({
          claude: { mode: "none", installed: false, subscriptionProviderRegistered: false, apiKeyProviderRegistered: false },
          openrouter: { configured: false },
          aliasesRegistered: [],
        }),
      }),
    ).get("/setup/state");
    expect(res.status).toBe(200);
    expect(res.body.mcpServers).toEqual({ registered: [], error: "apex-gateway rejected the credential (401)" });
  });
});
