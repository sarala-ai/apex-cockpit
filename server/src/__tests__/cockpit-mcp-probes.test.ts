/**
 * APEX-35 T10 — Cockpit MCP e2e probes (CI-gated).
 *
 * Probe A: run JWT + board:read → listIssues succeeds + audit row "ok".
 * Probe B: run JWT + board:read only → createComment denied + audit row "denied".
 *
 * These tests run against an in-process express server backed by an embedded
 * postgres database — no external services required.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { mcpRoutes } from "../mcp/router.js";
import { mintCockpitMcpJwt } from "../mcp/cockpit-mcp-jwt.js";

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

    // Build a minimal express app with body parsing + MCP routes.
    app = express();
    app.use(express.json({ limit: "4mb" }));
    app.use(mcpRoutes(db));

    process.env.PAPERCLIP_AGENT_JWT_SECRET = TEST_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_ISSUER = "paperclip-test";
  }, 30_000);

  afterEach(async () => {
    if (!companyId) return;
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
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
});
