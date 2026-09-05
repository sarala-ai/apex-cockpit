/**
 * The REST actor middleware consumes cockpit-issued principal JWTs:
 *   - an operator token → the same board actor a session/board key yields
 *   - a token naming no user (the retired cockpit-system subject) → unauthenticated
 *   - expired / foreign-signed → unauthenticated (401 at the route's gate)
 * Board keys, agent keys and sessions are untouched.
 */
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { agentApiKeys, authUsers, boardApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { assertAuthenticated, assertBoardOrAgent } from "../routes/authz.js";
import { apexSetupStateRoutes, type SetupStateProbes } from "../routes/apex-setup-state.js";
import {
  operatorClaims,
  signPrincipalJwt,
  testPrincipalKey,
} from "./helpers/principal-jwt.js";

const key = testPrincipalKey();
const COMPANY = "11111111-1111-4111-8111-111111111111";

function fakeDb(input: { user: boolean; memberships: string[]; admin?: boolean }) {
  const select = () => ({
    from(table: unknown) {
      return {
        where() {
          if (table === authUsers) return Promise.resolve(input.user ? [{ id: "user-1", name: "Op", email: "op@example.com" }] : []);
          if (table === companyMemberships) return Promise.resolve(input.memberships.map((companyId) => ({ companyId, membershipRole: "owner", status: "active" })));
          if (table === instanceUserRoles) return Promise.resolve(input.admin ? [{ id: "r1" }] : []);
          if (table === boardApiKeys || table === agentApiKeys) return Promise.resolve([]);
          return Promise.resolve([]);
        },
      };
    },
  });
  return { select, update: () => ({ set: () => ({ where: () => Promise.resolve([]) }) }), insert: () => ({ values: () => Promise.resolve([]) }) } as any;
}

const probes: SetupStateProbes = {
  auth: async () => ({ gcloud: "ok", gh: "ok", adc: "ok", source: "server", reportedAt: null, reportAgeMs: null }),
  org: async () => ({ present: true, id: "org-1", posture: "individual" }),
  membership: async () => ({ present: true, role: "owner", status: "active" }),
  companies: async () => ({ count: 1, ids: [COMPANY] }),
  scoping: async () => ({ orgProjectsBound: true, orgReposBound: true, companyProjectsBound: true, companyReposBound: true }),
  oauthClient: async () => ({ configured: true, signInClient: "configured", gatewayUpstreams: { total: 0, configured: 0 } }),
  gateway: async () => ({ reachable: true, url: "http://gw.test", authenticated: true, failure: null }),
  mcpServers: async () => ({ registered: [], cockpitMcp: { registered: true } }),
  models: async () => ({
    claude: { mode: "none", installed: false, source: "server", reportedAt: null, subscriptionProviderRegistered: false, apiKeyProviderRegistered: false },
    openrouter: { configured: false },
    aliasesRegistered: [],
    bridgeAvailable: true,
  }),
  claudeSession: async () => ({ connected: false, source: null, setAt: null }),
};

function createApp(db: any) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null, principalJwtVerifier: key.verifier }));
  app.use(boardMutationGuard());
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.get("/protected", (req, res) => {
    assertAuthenticated(req);
    res.json({ ok: true });
  });
  app.post("/api/companies/:companyId/issues", (req, res) => {
    assertBoardOrAgent(req);
    res.status(201).json({ created: true });
  });
  app.use("/api", apexSetupStateRoutes({} as unknown as Db, probes));
  app.use(errorHandler);
  return app;
}

const get = (app: express.Express, path: string, token: string) => request(app).get(path).set("Authorization", `Bearer ${token}`);

describe("actor middleware — operator principal JWT", () => {
  it("resolves to a board actor with the operator's DB companies and reaches /api/setup/state", async () => {
    const app = createApp(fakeDb({ user: true, memberships: [COMPANY] }));
    const token = signPrincipalJwt(key, operatorClaims({ companyId: COMPANY }));

    const actor = await get(app, "/actor", token);
    expect(actor.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userEmail: "op@example.com",
      companyIds: [COMPANY],
      isInstanceAdmin: false,
      source: "principal_jwt",
    });

    const state = await get(app, "/api/setup/state", token);
    expect(state.status).toBe(200);
    expect(state.body.companies).toEqual({ count: 1, ids: [COMPANY] });
  });

  it("takes instance-admin from the DB, not the claim", async () => {
    const app = createApp(fakeDb({ user: true, memberships: [], admin: false }));
    const res = await get(app, "/actor", signPrincipalJwt(key, operatorClaims({ instanceAdmin: true })));
    expect(res.body.isInstanceAdmin).toBe(false);
  });

  it("may mutate without a browser origin, like a board key", async () => {
    const app = createApp(fakeDb({ user: true, memberships: [COMPANY] }));
    const res = await request(app)
      .post(`/api/companies/${COMPANY}/issues`)
      .set("Authorization", `Bearer ${signPrincipalJwt(key, operatorClaims({ companyId: COMPANY }))}`)
      .send({ title: "x" });
    expect(res.status).toBe(201);
  });

  it("leaves an unknown user unauthenticated", async () => {
    const app = createApp(fakeDb({ user: false, memberships: [] }));
    const res = await get(app, "/protected", signPrincipalJwt(key, operatorClaims({ sub: "ghost" })));
    expect(res.status).toBe(401);
  });
});

describe("actor middleware — no process principal", () => {
  it("a token claiming the retired cockpit-system principal is just an unknown user", async () => {
    const app = createApp(fakeDb({ user: false, memberships: [] }));
    const token = signPrincipalJwt(key, operatorClaims({ sub: "cockpit-system", principalKind: "cockpit_system", instanceAdmin: true, companyId: null, companies: [] }));
    expect((await get(app, "/protected", token)).status).toBe(401);
    expect((await get(app, "/api/setup/state", token)).status).toBe(403);
  });
});

describe("actor middleware — rejected principal JWTs", () => {
  it("expired → 401 at the route gate", async () => {
    const app = createApp(fakeDb({ user: true, memberships: [COMPANY] }));
    const res = await get(app, "/protected", signPrincipalJwt(key, operatorClaims({ exp: Math.floor(Date.now() / 1000) - 1 })));
    expect(res.status).toBe(401);
  });

  it("invalid signature → 401 at the route gate", async () => {
    const app = createApp(fakeDb({ user: true, memberships: [COMPANY] }));
    const rogue = testPrincipalKey("k1");
    const res = await get(app, "/protected", signPrincipalJwt(rogue, operatorClaims()));
    expect(res.status).toBe(401);
  });

  it("wrong audience → 401 at the route gate", async () => {
    const app = createApp(fakeDb({ user: true, memberships: [COMPANY] }));
    const res = await get(app, "/protected", signPrincipalJwt(key, operatorClaims({ aud: "cockpit-mcp" })));
    expect(res.status).toBe(401);
  });

  it("without a verifier (local_trusted) a principal token is just an unknown bearer", async () => {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(fakeDb({ user: true, memberships: [COMPANY] }), { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.get("/protected", (req, res) => {
      assertAuthenticated(req);
      res.json({ ok: true });
    });
    app.use(errorHandler);
    const res = await get(app, "/protected", signPrincipalJwt(key, operatorClaims()));
    expect(res.status).toBe(401);
  });
});
