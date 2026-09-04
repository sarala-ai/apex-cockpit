import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { apexSetupStateRoutes, defaultProbes, type SetupStateProbes } from "../routes/apex-setup-state.js";
import type { GatewayClient } from "../gateway/gateway-client.js";
import { errorHandler } from "../middleware/index.js";

const healthy: SetupStateProbes = {
  auth: async () => ({ gcloud: "ok", gh: "ok", adc: "ok", source: "server", reportedAt: null, reportAgeMs: null }),
  org: async () => ({ present: true, id: "org-1", posture: "individual" }),
  membership: async () => ({ present: true, role: "owner", status: "active" }),
  companies: async () => ({ count: 2, ids: ["c1", "c2"] }),
  scoping: async () => ({
    orgProjectsBound: true,
    orgReposBound: true,
    companyProjectsBound: true,
    companyReposBound: true,
  }),
  oauthClient: async () => ({ configured: true, signInClient: "configured", gatewayUpstreams: { total: 1, configured: 1 } }),
  gateway: async () => ({ reachable: true, url: "http://gw.test", authenticated: true, failure: null }),
  mcpServers: async () => ({ registered: ["gworkspace"] }),
};

const modelsNone = async () => ({
  claude: {
    mode: "none" as const,
    installed: false,
    source: "server" as const,
    reportedAt: null,
    subscriptionProviderRegistered: false,
    apiKeyProviderRegistered: false,
  },
  openrouter: { configured: false },
  aliasesRegistered: [],
  bridgeAvailable: true,
});

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
    const res = await request(appWith({ models: modelsNone })).get("/setup/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      auth: { gcloud: "ok", gh: "ok", adc: "ok", source: "server", reportedAt: null, reportAgeMs: null },
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
      oauthClient: { configured: true, signInClient: "configured", gatewayUpstreams: { total: 1, configured: 1 } },
      gateway: { reachable: true, url: "http://gw.test", authenticated: true, failure: null },
      mcpServers: { registered: ["gworkspace"] },
      models: await modelsNone(),
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
    expect(res.body.auth).toEqual({ gcloud: "missing", gh: "missing", adc: "missing", source: "none", reportedAt: null, reportAgeMs: null });
    expect(res.body.gateway).toMatchObject({ reachable: false, authenticated: null, failure: { kind: "unreachable" } });
    expect(typeof res.body.gateway.url).toBe("string");
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
  const rejected = { kind: "unauthenticated", status: 401, message: "apex-gateway rejected the credential (401)" } as const;

  it("reports the configured URL and distinguishes unreachable from a rejected credential", async () => {
    const probesFor = (probe: () => Promise<unknown>) =>
      defaultProbes({} as unknown as Db, { probe } as unknown as GatewayClient, { APEX_GATEWAY_URL: "http://gw.test/" });
    const prevUrl = process.env.APEX_GATEWAY_URL;
    process.env.APEX_GATEWAY_URL = "http://gw.test/";
    try {
      expect(await probesFor(async () => ({ reachable: true, authenticated: true, failure: null })).gateway()).toEqual({
        reachable: true, url: "http://gw.test", authenticated: true, failure: null,
      });
      expect(await probesFor(async () => ({ reachable: true, authenticated: false, failure: rejected })).gateway()).toEqual({
        reachable: true, url: "http://gw.test", authenticated: false, failure: rejected,
      });
      const down = { kind: "unreachable", status: null, message: "apex-gateway is unreachable" };
      expect(await probesFor(async () => ({ reachable: false, authenticated: null, failure: down })).gateway()).toEqual({
        reachable: false, url: "http://gw.test", authenticated: null, failure: down,
      });
    } finally {
      if (prevUrl === undefined) delete process.env.APEX_GATEWAY_URL;
      else process.env.APEX_GATEWAY_URL = prevUrl;
    }
  });

  it("oauthClient checks the cockpit sign-in client and the gateway's OAuth upstreams, never GOOGLE_OAUTH_CLIENT_ID", async () => {
    const withPosture = (rows: unknown, env: NodeJS.ProcessEnv) =>
      defaultProbes(
        {} as unknown as Db,
        { readGatewayOauthPosture: async () => ({ ok: true, value: rows }) } as unknown as GatewayClient,
        env,
      );
    const hosted = { PAPERCLIP_DEPLOYMENT_MODE: "authenticated", GOOGLE_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_ID: "ignored" };
    const upstreams = [
      { name: "gworkspace", authType: "oauth", oauthConfigured: true },
      { name: "jira", authType: "oauth", oauthConfigured: false },
      { name: "cockpit-mcp", authType: "bearer", oauthConfigured: false },
    ];
    expect(await withPosture(upstreams, hosted).oauthClient()).toEqual({
      configured: false,
      signInClient: "configured",
      gatewayUpstreams: { total: 2, configured: 1 },
    });
    expect(await withPosture(upstreams.slice(0, 1), hosted).oauthClient()).toEqual({
      configured: true,
      signInClient: "configured",
      gatewayUpstreams: { total: 1, configured: 1 },
    });
    // Only the env var config.ts reads counts.
    expect(await withPosture([], { PAPERCLIP_DEPLOYMENT_MODE: "authenticated", GOOGLE_OAUTH_CLIENT_ID: "x" }).oauthClient()).toMatchObject({
      configured: false,
      signInClient: "missing",
    });
    // A local instance has no sign-in client to check.
    expect(await withPosture([], {}).oauthClient()).toEqual({
      configured: true,
      signInClient: "not_applicable",
      gatewayUpstreams: { total: 0, configured: 0 },
    });
  });

  it("oauthClient is not green when the registry cannot be read", async () => {
    const probes = defaultProbes(
      {} as unknown as Db,
      { readGatewayOauthPosture: async () => ({ ok: false, failure: rejected }) } as unknown as GatewayClient,
      { PAPERCLIP_DEPLOYMENT_MODE: "authenticated", GOOGLE_CLIENT_ID: "cid" },
    );
    expect(await probes.oauthClient()).toEqual({
      configured: false,
      signInClient: "configured",
      gatewayUpstreams: { total: 0, configured: 0, error: rejected.message },
      note: "gateway registry could not be read",
    });
  });

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
        models: modelsNone,
      }),
    ).get("/setup/state");
    expect(res.status).toBe(200);
    expect(res.body.mcpServers).toEqual({ registered: [], error: "apex-gateway rejected the credential (401)" });
  });
});
