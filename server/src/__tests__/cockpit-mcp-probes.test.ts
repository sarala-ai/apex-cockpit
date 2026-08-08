/**
 * APEX-35 T10 — Cockpit MCP e2e probes (CI-gated).
 *
 * Probe A: run JWT + board:read → listIssues succeeds + audit row "ok".
 * Probe B: run JWT + board:read only → createComment denied + audit row "denied".
 * Probe C: headless OAuth 2.1 + PKCE flow → tools/list succeeds with a
 *          user-scoped identity (userId set, runId null) in the audit row.
 * Probe D: T11 stdio shim — initialize + tools/list over stdio match a direct
 *          streamable-HTTP session with the same token; token accepted only
 *          from PAPERCLIP_MCP_TOKEN; audit identity identical to direct HTTP.
 *
 * These tests run against an in-process express server backed by an embedded
 * postgres database — no external services required.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { mcpRoutes } from "../mcp/router.js";
import { oauthRoutes } from "../mcp/oauth.js";
import { mintCockpitMcpJwt } from "../mcp/cockpit-mcp-jwt.js";
import { resolveShimConfig, runStdioShim } from "../mcp/stdio-shim.js";

// ─── MCP protocol helpers ─────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

function mcpInitialize(): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "apex-35-probe", version: "0.0.0" },
    },
  };
}

function mcpToolCall(id: number, name: string, args: Record<string, unknown>): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

// Parse the first JSON-RPC message from an SSE response body.
// SSE lines look like: `data: {...}\n\n`
function parseSseJsonRpc(text: string): Record<string, unknown> {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice("data:".length).trim();
      if (payload) {
        try {
          return JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // skip non-JSON data lines
        }
      }
    }
  }
  // Fallback: try parsing the whole body as JSON.
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The JWT mint requires PAPERCLIP_AGENT_JWT_SECRET.
const TEST_JWT_SECRET = "apex-35-test-jwt-secret-minimum-32-chars!!";

describeEmbeddedPostgres("cockpit MCP e2e probes (APEX-35 T10)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof express>;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mcp-probe-");
    db = createDb(tempDb.connectionString);

    // Build a minimal express app with body parsing + MCP + OAuth routes.
    // The session resolver stands in for better-auth: it authenticates
    // whichever user id the test put in the `x-test-user-id` header.
    app = express();
    app.use(express.json({ limit: "4mb" }));
    app.use(mcpRoutes(db));
    app.use(
      oauthRoutes(db, {
        resolveUserId: async (req) => {
          const v = req.headers["x-test-user-id"];
          return typeof v === "string" && v.length > 0 ? v : null;
        },
      }),
    );

    process.env.PAPERCLIP_AGENT_JWT_SECRET = TEST_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_ISSUER = "paperclip-test";
  }, 30_000);

  afterEach(async () => {
    if (!companyId) return;
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  afterAll(async () => {
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_ISSUER;
    await tempDb?.cleanup();
  });

  async function seed(runId: string) {
    const [company] = await db
      .insert(companies)
      .values({
        name: "MCP Probe Co",
        issuePrefix: `MP${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      })
      .returning();
    companyId = company!.id;

    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Probe Agent", role: "engineer" })
      .returning();
    agentId = agent!.id;

    // heartbeat_runs FK is required for audit rows.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });

    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "MCP probe issue", status: "todo" })
      .returning();

    return { company: company!, agent: agent!, issue: issue! };
  }

  function mintReadOnlyJwt(runId: string) {
    return mintCockpitMcpJwt({
      agentId,
      companyId,
      runId,
      adapterType: "local_trusted",
      grantedCapabilities: ["board:read"],
    });
  }

  // ─── Probe A ───────────────────────────────────────────────────────────────
  it("Probe A: board:read JWT → listIssues succeeds + audit row ok", async () => {
    const runId = randomUUID();
    await seed(runId);
    const token = mintReadOnlyJwt(runId);
    expect(token).toBeTruthy();

    // Initialize first (required by MCP protocol, stateless = new connection each time).
    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send(mcpInitialize())
      .expect((res) => {
        expect(res.status).toBe(200);
      });

    // Call listIssues.
    const toolRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send(mcpToolCall(2, "listIssues", {}));

    expect(toolRes.status).toBe(200);

    // MCP streamable-HTTP transport returns SSE (text/event-stream).
    const body = parseSseJsonRpc(toolRes.text ?? "");
    // Should be a JSON-RPC result (not error).
    expect(body.error).toBeUndefined();
    const result = body.result as Record<string, unknown> | undefined;
    const resultText: string = (result?.content as Array<{ text: string }>)?.[0]?.text ?? "";
    const parsed = JSON.parse(resultText);
    expect(Array.isArray(parsed.issues)).toBe(true);

    // Verify audit row was written with outcome "ok".
    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, runId));
    const okRow = auditRows.find((r) => (r.details as Record<string, unknown>)?.outcome === "ok");
    expect(okRow).toBeDefined();
    expect((okRow!.details as Record<string, unknown>).tool).toBe("listIssues");
    expect(okRow!.runId).toBe(runId);
  }, 20_000);

  // ─── Probe B ───────────────────────────────────────────────────────────────
  it("Probe B: board:read-only JWT → createComment denied + audit row denied", async () => {
    const runId = randomUUID();
    const { issue } = await seed(runId);
    const token = mintReadOnlyJwt(runId); // only board:read, NOT board:write
    expect(token).toBeTruthy();

    // Initialize.
    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send(mcpInitialize());

    // Attempt createComment (requires board:write) — should be denied.
    const toolRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send(mcpToolCall(2, "createComment", { issueId: issue.id, body: "should be denied" }));

    // MCP returns HTTP 200 with SSE payload; capability failure is an error.
    expect(toolRes.status).toBe(200);
    const body = parseSseJsonRpc(toolRes.text ?? "");
    // Should be an error response (JSON-RPC error or isError tool result).
    const result = body.result as Record<string, unknown> | undefined;
    const hasError =
      body.error !== undefined ||
      result?.isError === true;
    expect(hasError).toBe(true);

    // Verify audit row was written with outcome "denied".
    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, runId));
    const deniedRow = auditRows.find(
      (r) => (r.details as Record<string, unknown>)?.outcome === "denied",
    );
    expect(deniedRow).toBeDefined();
    expect((deniedRow!.details as Record<string, unknown>).tool).toBe("createComment");
    expect(deniedRow!.runId).toBe(runId);
  }, 20_000);

  // ─── Probe C ───────────────────────────────────────────────────────────────

  const OAUTH_CLIENT_ID = "apex-35-probe-client";
  const OAUTH_REDIRECT_URI = "http://localhost:9/callback";
  const OAUTH_RESOURCE = "http://localhost:3000/mcp";

  function pkcePair() {
    const verifier = randomUUID() + randomUUID();
    const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
    return { verifier, challenge };
  }

  function authorizeQuery(challenge: string, overrides: Record<string, string | null> = {}) {
    const params = new URLSearchParams();
    const base: Record<string, string> = {
      response_type: "code",
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: OAUTH_RESOURCE,
      state: "probe-state",
    };
    for (const [k, v] of Object.entries({ ...base, ...overrides })) {
      if (v !== null) params.set(k, v);
    }
    return params.toString();
  }

  async function seedUserMembership(): Promise<string> {
    const userId = `probe-user-${randomUUID()}`;
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
    });
    return userId;
  }

  it("Probe C: OAuth 2.1 PKCE flow → tools/list succeeds, audit row user-scoped", async () => {
    const runId = randomUUID();
    await seed(runId);
    const userId = await seedUserMembership();
    const { verifier, challenge } = pkcePair();

    // Authorize: authenticated user → 302 with code + state.
    const authRes = await request(app)
      .get(`/oauth/authorize?${authorizeQuery(challenge)}`)
      .set("x-test-user-id", userId);
    expect(authRes.status).toBe(302);
    const location = new URL(authRes.headers.location!);
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("probe-state");

    // Token exchange with the matching verifier.
    const tokenRes = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: code!,
        code_verifier: verifier,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        resource: OAUTH_RESOURCE,
      });
    expect(tokenRes.status).toBe(200);
    const accessToken = tokenRes.body.access_token as string;
    expect(accessToken).toBeTruthy();
    expect(tokenRes.body.token_type).toBe("Bearer");

    // The access token is accepted by the /mcp middleware: initialize + tools/list.
    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send(mcpInitialize())
      .expect((res) => {
        expect(res.status).toBe(200);
      });

    const listRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(listRes.status).toBe(200);
    const body = parseSseJsonRpc(listRes.text ?? "");
    expect(body.error).toBeUndefined();
    const tools = (body.result as { tools?: Array<{ name: string }> })?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);

    // Audit row is user-scoped: userId set, runId null.
    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));
    const listRow = auditRows.find(
      (r) => (r.details as Record<string, unknown>)?.tool === "tools/list",
    );
    expect(listRow).toBeDefined();
    expect(listRow!.runId).toBeNull();
    expect(listRow!.agentId).toBeNull();
    expect(listRow!.actorType).toBe("user");
    expect(listRow!.actorId).toBe(userId);
    expect((listRow!.details as Record<string, unknown>).userId).toBe(userId);
  }, 20_000);

  it("OAuth: missing code_challenge and plain method are invalid_request; bad resource is invalid_target", async () => {
    const runId = randomUUID();
    await seed(runId);
    const userId = await seedUserMembership();
    const { challenge } = pkcePair();

    const noChallenge = await request(app)
      .get(`/oauth/authorize?${authorizeQuery(challenge, { code_challenge: null })}`)
      .set("x-test-user-id", userId);
    expect(noChallenge.status).toBe(400);
    expect(noChallenge.body.error).toBe("invalid_request");

    const plainMethod = await request(app)
      .get(`/oauth/authorize?${authorizeQuery(challenge, { code_challenge_method: "plain" })}`)
      .set("x-test-user-id", userId);
    expect(plainMethod.status).toBe(400);
    expect(plainMethod.body.error).toBe("invalid_request");

    const badResource = await request(app)
      .get(`/oauth/authorize?${authorizeQuery(challenge, { resource: "http://localhost:3000/not-mcp" })}`)
      .set("x-test-user-id", userId);
    expect(badResource.status).toBe(400);
    expect(badResource.body.error).toBe("invalid_target");

    const noAuth = await request(app).get(`/oauth/authorize?${authorizeQuery(challenge)}`);
    expect(noAuth.status).toBe(401);
  }, 20_000);

  it("OAuth: wrong code_verifier is invalid_grant and burns the code", async () => {
    const runId = randomUUID();
    await seed(runId);
    const userId = await seedUserMembership();
    const { verifier, challenge } = pkcePair();

    const authRes = await request(app)
      .get(`/oauth/authorize?${authorizeQuery(challenge)}`)
      .set("x-test-user-id", userId);
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers.location!).searchParams.get("code")!;

    const wrongVerifier = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        code_verifier: "not-the-right-verifier-at-all-0000000000",
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        resource: OAUTH_RESOURCE,
      });
    expect(wrongVerifier.status).toBe(400);
    expect(wrongVerifier.body.error).toBe("invalid_grant");

    // Single-use: the correct verifier no longer works either.
    const retry = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        resource: OAUTH_RESOURCE,
      });
    expect(retry.status).toBe(400);
    expect(retry.body.error).toBe("invalid_grant");
  }, 20_000);

  // ─── Probe D (T11) ─────────────────────────────────────────────────────────

  type ShimSession = {
    send: (message: unknown) => void;
    nextMessage: () => Promise<Record<string, unknown>>;
  };

  // Run the shim against a real listening socket (not supertest) so the probe
  // exercises the same HTTP path an external stdio host would.
  async function withShim(token: string, fn: (session: ShimSession) => Promise<void>) {
    const httpServer: Server = app.listen(0);
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));
    const port = (httpServer.address() as AddressInfo).port;

    const input = new PassThrough();
    const output = new PassThrough();
    const pendingLines: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    let buffered = "";
    output.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newlineIdx: number;
      while ((newlineIdx = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newlineIdx);
        buffered = buffered.slice(newlineIdx + 1);
        const waiter = waiters.shift();
        if (waiter) waiter(line);
        else pendingLines.push(line);
      }
    });

    const shimDone = runStdioShim({
      input,
      output,
      token,
      url: `http://127.0.0.1:${port}/mcp`,
    });

    const session: ShimSession = {
      send: (message) => {
        input.write(`${JSON.stringify(message)}\n`);
      },
      nextMessage: () =>
        new Promise((resolve) => {
          const queued = pendingLines.shift();
          if (queued !== undefined) resolve(JSON.parse(queued) as Record<string, unknown>);
          else waiters.push((line) => resolve(JSON.parse(line) as Record<string, unknown>));
        }),
    };

    try {
      await fn(session);
    } finally {
      input.end();
      await shimDone;
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  }

  it("Probe D: stdio shim initialize + tools/list match direct HTTP; audit identity identical", async () => {
    const runId = randomUUID();
    await seed(runId);
    const token = mintReadOnlyJwt(runId);
    expect(token).toBeTruthy();

    // Direct streamable-HTTP session with the same token, for comparison.
    await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send(mcpInitialize())
      .expect((res) => expect(res.status).toBe(200));
    const directListRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(directListRes.status).toBe(200);
    const directList = parseSseJsonRpc(directListRes.text ?? "");
    expect(directList.error).toBeUndefined();

    await withShim(token, async (shim) => {
      shim.send(mcpInitialize());
      const initResponse = await shim.nextMessage();
      expect(initResponse.error).toBeUndefined();
      const initResult = initResponse.result as Record<string, unknown>;
      expect(initResult.serverInfo).toMatchObject({ name: "cockpit-mcp" });

      shim.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const listResponse = await shim.nextMessage();
      expect(listResponse.error).toBeUndefined();
      // Byte-equivalent to the direct-HTTP session, modulo transport framing.
      expect(JSON.stringify(listResponse.result)).toBe(JSON.stringify(directList.result));

      shim.send(mcpToolCall(3, "listIssues", {}));
      const toolResponse = await shim.nextMessage();
      expect(toolResponse.error).toBeUndefined();
      const result = toolResponse.result as Record<string, unknown>;
      const text: string = (result.content as Array<{ text: string }>)?.[0]?.text ?? "";
      expect(Array.isArray(JSON.parse(text).issues)).toBe(true);
    });

    // Audit rows via the shim carry identity identical to direct-HTTP calls.
    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, runId));
    const listIssueRows = auditRows.filter(
      (r) => (r.details as Record<string, unknown>)?.tool === "listIssues",
    );
    expect(listIssueRows.length).toBe(1); // only the shim called listIssues
    const shimRow = listIssueRows[0]!;
    expect(shimRow.runId).toBe(runId);
    expect(shimRow.agentId).toBe(agentId);
    expect((shimRow.details as Record<string, unknown>).outcome).toBe("ok");
    // tools/list was called once directly and once via the shim; both rows
    // must carry the same identity content.
    const toolsListRows = auditRows.filter(
      (r) => (r.details as Record<string, unknown>)?.tool === "tools/list",
    );
    expect(toolsListRows.length).toBe(2);
    for (const row of toolsListRows) {
      expect(row.runId).toBe(runId);
      expect(row.agentId).toBe(agentId);
      expect((row.details as Record<string, unknown>).outcome).toBe("ok");
    }
  }, 30_000);
});

// ─── T11 shim config guards (no DB needed) ────────────────────────────────────

describe("stdio shim config guards (APEX-35 T11)", () => {
  const SHIM_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../mcp/stdio-shim.ts",
  );

  function runShimCli(env: Record<string, string>, args: string[] = []) {
    return spawnSync(process.execPath, ["--import", "tsx", SHIM_PATH, ...args], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      env: { ...process.env, PAPERCLIP_MCP_TOKEN: "", PAPERCLIP_MCP_URL: "", ...env },
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  it("rejects tokens passed via argv or flags", () => {
    expect(resolveShimConfig({ PAPERCLIP_MCP_URL: "http://x/mcp" }, ["--token=abc"]).ok).toBe(false);
    expect(resolveShimConfig({ PAPERCLIP_MCP_URL: "http://x/mcp" }, ["abc.def.ghi"]).ok).toBe(false);

    const result = runShimCli(
      { PAPERCLIP_MCP_TOKEN: "env-token", PAPERCLIP_MCP_URL: "http://127.0.0.1:9/mcp" },
      ["--token=argv-token"],
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no arguments");
  }, 40_000);

  it("exits nonzero without PAPERCLIP_MCP_TOKEN and never opens an anonymous session", () => {
    const unset = resolveShimConfig({ PAPERCLIP_MCP_URL: "http://x/mcp" }, []);
    expect(unset.ok).toBe(false);
    if (!unset.ok) expect(unset.error).toContain("PAPERCLIP_MCP_TOKEN");

    const result = runShimCli({ PAPERCLIP_MCP_URL: "http://127.0.0.1:9/mcp" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("PAPERCLIP_MCP_TOKEN");
    expect(result.stderr).toContain("anonymous");
  }, 40_000);
});
