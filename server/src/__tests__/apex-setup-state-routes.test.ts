import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { apexSetupStateRoutes, type SetupStateProbes } from "../routes/apex-setup-state.js";
import { errorHandler } from "../middleware/index.js";

const healthy: SetupStateProbes = {
  auth: async () => ({ gcloud: "ok", gh: "ok", adc: "ok" }),
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
    const res = await request(appWith({})).get("/setup/state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      auth: { gcloud: "ok", gh: "ok", adc: "ok" },
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
    expect(res.body.auth).toEqual({ gcloud: "missing", gh: "missing", adc: "missing" });
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
