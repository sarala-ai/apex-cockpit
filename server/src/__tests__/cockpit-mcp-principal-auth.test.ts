/**
 * cockpit-mcp accepts the cockpit's own operator principal JWTs next to run
 * tokens:
 *   - operator principal: authorized as that operator (board:read, one company)
 *   - cockpit-system principal: 403 (cockpit does not call itself)
 *   - run JWT: unchanged
 * Verification is real (EdDSA against a test JWKS); the DB is a stub that
 * answers the few reads the operator mapping and listIssues need.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, authUsers, companyMemberships, instanceUserRoles, issues } from "@paperclipai/db";
import { mcpRoutes } from "../mcp/router.js";
import { mintCockpitMcpJwt } from "../mcp/cockpit-mcp-jwt.js";
import { CAP_BOARD_READ } from "../mcp/capabilities.js";
import {
  cockpitSystemClaims,
  operatorClaims,
  signPrincipalJwt,
  testPrincipalKey,
} from "./helpers/principal-jwt.js";

const ACCEPT = "application/json, text/event-stream";

function parseSseJsonRpc(text: string): Record<string, unknown> {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      try {
        return JSON.parse(trimmed.slice("data:".length).trim()) as Record<string, unknown>;
      } catch {
        // not this line
      }
    }
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params });
const initialize = () =>
  rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });

/** A chainable, thenable stub for drizzle's select builder: every method
 *  returns the chain; awaiting it yields the rows for the table `from` saw. */
function fakeDb(rowsFor: (table: unknown) => unknown[]) {
  const activity: Array<Record<string, unknown>> = [];
  const select = () => {
    let table: unknown;
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "innerJoin"]) {
      chain[m] = (arg: unknown) => {
        if (m === "from") table = arg;
        return chain;
      };
    }
    chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor(table)).then(resolve, reject);
    return chain;
  };
  return {
    activity,
    db: {
      select,
      insert: (table: unknown) => ({
        values(values: Record<string, unknown>) {
          if (table === activityLog) activity.push(values);
          return Promise.resolve([]);
        },
      }),
    } as any,
  };
}

const key = testPrincipalKey();
const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";

function appFor(memberships: Array<{ companyId: string }>, opts: { admin?: boolean } = {}) {
  const { db, activity } = fakeDb((table) => {
    if (table === authUsers) return [{ id: "user-1", name: "Op", email: "op@example.com" }];
    if (table === companyMemberships) return memberships.map((m) => ({ ...m, membershipRole: "owner", status: "active" }));
    if (table === instanceUserRoles) return opts.admin ? [{ id: "r1" }] : [];
    if (table === issues) return [{ id: "i1", identifier: "T-1", title: "one", status: "todo", projectId: null, assigneeAgentId: null, createdAt: new Date(), updatedAt: new Date() }];
    return [];
  });
  const app = express();
  app.use(express.json());
  app.use(mcpRoutes(db, { principalJwtVerifier: key.verifier }));
  return { app, activity };
}

const post = (app: express.Express, token: string, body: unknown, headers: Record<string, string> = {}) =>
  request(app).post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", ACCEPT).set(headers).send(body);

describe("cockpit-mcp — operator principal", () => {
  it("is authorized as that operator for their single company, with board:read", async () => {
    const { app, activity } = appFor([{ companyId: COMPANY }]);
    const token = signPrincipalJwt(key, operatorClaims({ companyId: COMPANY, companies: [] }));
    const res = await post(app, token, rpc(1, "tools/call", { name: "listIssues", arguments: {} }));
    expect(res.status).toBe(200);
    const body = parseSseJsonRpc(res.text) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(body.result.content[0]!.text).issues).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: "user", actorId: "user-1", companyId: COMPANY, entityId: "listIssues" });
    expect((activity[0]!.details as { grantedCapabilities: string[] }).grantedCapabilities).toEqual([CAP_BOARD_READ]);
  });

  it("cannot write: board writes attribute to a run, which an operator token is not", async () => {
    const { app } = appFor([{ companyId: COMPANY }]);
    const token = signPrincipalJwt(key, operatorClaims({ companyId: COMPANY }));
    const res = await post(app, token, rpc(1, "tools/call", { name: "createIssue", arguments: { title: "x" } }));
    expect(res.status).toBe(200);
    const body = parseSseJsonRpc(res.text) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } };
    const text = body.result?.content?.[0]?.text ?? body.error?.message ?? "";
    expect(text).toMatch(/board:write|capability/i);
  });

  it("selects the company from the header, then the token, then the sole membership — never a guess", async () => {
    const two = [{ companyId: COMPANY }, { companyId: OTHER_COMPANY }];
    const ambiguous = signPrincipalJwt(key, operatorClaims({ companyId: null, companies: [] }));
    const { app } = appFor(two);
    const res = await post(app, ambiguous, rpc(1, "tools/list"));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("ambiguous_company");

    const viaHeader = await post(app, ambiguous, rpc(1, "tools/list"), { "X-Paperclip-Company-Id": OTHER_COMPANY });
    expect(viaHeader.status).toBe(200);

    const foreign = await post(app, ambiguous, rpc(1, "tools/list"), { "X-Paperclip-Company-Id": "33333333-3333-4333-8333-333333333333" });
    expect(foreign.status).toBe(403);
    expect(foreign.body.reason).toBe("company_forbidden");

    const viaToken = await post(app, signPrincipalJwt(key, operatorClaims({ companyId: COMPANY })), rpc(1, "tools/list"));
    expect(viaToken.status).toBe(200);
  });

  it("is 401 for a user this instance does not know", async () => {
    const { db } = fakeDb(() => []);
    const app = express();
    app.use(express.json());
    app.use(mcpRoutes(db, { principalJwtVerifier: key.verifier }));
    const res = await post(app, signPrincipalJwt(key, operatorClaims({ sub: "ghost" })), rpc(1, "tools/list"));
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("unknown_user");
  });
});

describe("cockpit-mcp — rejected principals", () => {
  it("401s an expired token and a token signed by a foreign key", async () => {
    const { app } = appFor([{ companyId: COMPANY }]);
    const expired = await post(app, signPrincipalJwt(key, operatorClaims({ exp: Math.floor(Date.now() / 1000) - 5 })), rpc(1, "tools/list"));
    expect(expired.status).toBe(401);
    expect(expired.body.reason).toBe("expired");

    const rogue = testPrincipalKey("k1");
    const forged = await post(app, signPrincipalJwt(rogue, operatorClaims()), rpc(1, "tools/list"));
    expect(forged.status).toBe(401);
    expect(forged.body.reason).toBe("bad_signature");
  });

  it("403s the cockpit-system principal — cockpit does not call itself", async () => {
    const { app } = appFor([]);
    const res = await post(app, signPrincipalJwt(key, cockpitSystemClaims()), rpc(1, "tools/list"));
    expect(res.status).toBe(403);
    expect(res.body.reason).toBe("principal_not_permitted");
  });

  it("401s an EdDSA token when no verifier is configured (local_trusted)", async () => {
    const { db } = fakeDb(() => []);
    const app = express();
    app.use(express.json());
    app.use(mcpRoutes(db));
    const res = await post(app, signPrincipalJwt(key, operatorClaims()), rpc(1, "tools/list"));
    expect(res.status).toBe(401);
  });
});

describe("cockpit-mcp — run JWT unchanged", () => {
  beforeAll(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "cockpit-mcp-principal-auth-test-secret!!");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("still lists tools and audits as the run's agent", async () => {
    const { app, activity } = appFor([]);
    const token = mintCockpitMcpJwt({
      agentId: "44444444-4444-4444-8444-444444444444",
      companyId: COMPANY,
      runId: "55555555-5555-4555-8555-555555555555",
      adapterType: "claude_local",
      grantedCapabilities: [CAP_BOARD_READ],
    });
    expect(token).toBeTruthy();
    const res = await post(app, token!, rpc(1, "tools/list"));
    expect(res.status).toBe(200);
    expect(activity[0]).toMatchObject({ actorType: "agent", entityId: "tools/list", companyId: COMPANY });
  });
});
