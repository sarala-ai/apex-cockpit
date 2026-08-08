/**
 * Cockpit MCP server — streamable-HTTP transport mounted at /mcp.
 *
 * Identity model:
 *   - Dispatched runs: bearer JWT with aud "cockpit-mcp", minted at dispatch.
 *   - Chat-panel: same JWT bearer, capability set restricted to draft:write.
 *   - External hosts: OAuth 2.1 + PKCE (T7, not yet implemented; endpoint returns 501).
 *
 * Every request follows the pattern:
 *   1. Extract + verify JWT → 401 on failure.
 *   2. Build McpServer with company-scoped tool handlers.
 *   3. Connect a stateless StreamableHTTPServerTransport.
 *   4. Each tool handler checks grantedCapabilities → 403 + audit row on deny.
 *   5. Handler result → audit row with outcome "ok".
 */
import { Router, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { verifyCockpitMcpJwt, type CockpitMcpJwtClaims } from "./cockpit-mcp-jwt.js";
import { GatewayClient } from "../gateway/gateway-client.js";
import { logger } from "../middleware/logger.js";

// ─── Capabilities ────────────────────────────────────────────────────────────

export const CAP_BOARD_READ = "board:read";
export const CAP_BOARD_WRITE = "board:write";
export const CAP_DRAFT_WRITE = "draft:write";

// ─── Audit ───────────────────────────────────────────────────────────────────

type AuditOutcome = "ok" | "denied" | "error";

async function writeAuditRow(
  db: Db,
  input: {
    claims: CockpitMcpJwtClaims;
    tool: string;
    requiredCapability: string;
    outcome: AuditOutcome;
    errorMessage?: string;
  },
): Promise<void> {
  try {
    await db.insert(activityLog).values({
      companyId: input.claims.company_id,
      actorType: "agent",
      actorId: input.claims.sub,
      action: "mcp_tool_call",
      entityType: "mcp_tool",
      entityId: input.tool,
      agentId: input.claims.sub,
      runId: input.claims.run_id,
      details: {
        tool: input.tool,
        requiredCapability: input.requiredCapability,
        outcome: input.outcome,
        runId: input.claims.run_id,
        grantedCapabilities: input.claims.granted_capabilities,
        issueId: input.claims.issue_id ?? null,
        caseId: input.claims.case_id ?? null,
        projectId: input.claims.project_id ?? null,
        ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to write MCP audit row");
  }
}

// ─── Capability gate ─────────────────────────────────────────────────────────

class CapabilityDeniedError extends Error {
  constructor(
    public readonly tool: string,
    public readonly required: string,
  ) {
    super(`capability ${required} required for tool ${tool}`);
  }
}

function requireCapability(claims: CockpitMcpJwtClaims, cap: string, tool: string): void {
  if (!claims.granted_capabilities.includes(cap)) {
    throw new CapabilityDeniedError(tool, cap);
  }
}

// draft:write auto-attenuation: tools excluded from draft-write sessions
const DRAFT_WRITE_EXCLUDED_TOOLS = new Set([
  "updateIssue", // status transitions require board:write
]);

function isToolVisibleForClaims(toolName: string, claims: CockpitMcpJwtClaims): boolean {
  const isDraftOnly =
    claims.granted_capabilities.includes(CAP_DRAFT_WRITE) &&
    !claims.granted_capabilities.includes(CAP_BOARD_WRITE);
  if (isDraftOnly && DRAFT_WRITE_EXCLUDED_TOOLS.has(toolName)) return false;
  return true;
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleWithAudit<T>(
  db: Db,
  claims: CockpitMcpJwtClaims,
  tool: string,
  requiredCapability: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    await writeAuditRow(db, { claims, tool, requiredCapability, outcome: "ok" });
    return result;
  } catch (err) {
    if (err instanceof CapabilityDeniedError) {
      await writeAuditRow(db, { claims, tool, requiredCapability, outcome: "denied" });
    } else {
      await writeAuditRow(db, {
        claims,
        tool,
        requiredCapability,
        outcome: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}

// ─── Build per-request McpServer ─────────────────────────────────────────────

function buildMcpServer(db: Db, claims: CockpitMcpJwtClaims): McpServer {
  const server = new McpServer(
    { name: "cockpit-mcp", version: "0.1.0" },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // T4 — Board API read tools

  server.tool(
    "listIssues",
    "List issues for the authenticated run's company",
    {
      projectId: z.string().uuid().optional().describe("Filter by project ID"),
      status: z.string().optional().describe("Filter by status"),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ projectId, status, limit }) => {
      return handleWithAudit(db, claims, "listIssues", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "listIssues");
        // In-process service call (T4 implementation stub — returns empty list until
        // the service layer integration is wired in a follow-up heartbeat).
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ issues: [], companyId: claims.company_id, projectId, status, limit }),
            },
          ],
        };
      });
    },
  );

  server.tool(
    "getIssue",
    "Get a single issue by ID",
    {
      issueId: z.string().uuid().describe("Issue ID"),
    },
    async ({ issueId }) => {
      return handleWithAudit(db, claims, "getIssue", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "getIssue");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ issue: null, issueId, companyId: claims.company_id }),
            },
          ],
        };
      });
    },
  );

  server.tool(
    "listComments",
    "List comments on an issue",
    {
      issueId: z.string().uuid().describe("Issue ID"),
    },
    async ({ issueId }) => {
      return handleWithAudit(db, claims, "listComments", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "listComments");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ comments: [], issueId, companyId: claims.company_id }),
            },
          ],
        };
      });
    },
  );

  server.tool(
    "getHeartbeatContext",
    "Get the current run's heartbeat context (issue, case, project)",
    {},
    async () => {
      return handleWithAudit(db, claims, "getHeartbeatContext", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "getHeartbeatContext");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                runId: claims.run_id,
                agentId: claims.sub,
                companyId: claims.company_id,
                issueId: claims.issue_id,
                caseId: claims.case_id,
                projectId: claims.project_id,
              }),
            },
          ],
        };
      });
    },
  );

  // T5 — Board API write tools

  server.tool(
    "createComment",
    "Create a comment on an issue",
    {
      issueId: z.string().uuid().describe("Issue ID"),
      body: z.string().min(1).describe("Comment body (Markdown)"),
    },
    async ({ issueId, body }) => {
      return handleWithAudit(db, claims, "createComment", CAP_BOARD_WRITE, async () => {
        requireCapability(claims, CAP_BOARD_WRITE, "createComment");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ comment: null, issueId, body, companyId: claims.company_id }),
            },
          ],
        };
      });
    },
  );

  server.tool(
    "createIssue",
    "Create a new issue",
    {
      title: z.string().min(1).describe("Issue title"),
      description: z.string().optional().describe("Issue description (Markdown)"),
      projectId: z.string().uuid().optional().describe("Project to create the issue in"),
    },
    async ({ title, description, projectId }) => {
      return handleWithAudit(db, claims, "createIssue", CAP_BOARD_WRITE, async () => {
        requireCapability(claims, CAP_BOARD_WRITE, "createIssue");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ issue: null, title, description, projectId, companyId: claims.company_id }),
            },
          ],
        };
      });
    },
  );

  if (isToolVisibleForClaims("updateIssue", claims)) {
    server.tool(
      "updateIssue",
      "Update an existing issue",
      {
        issueId: z.string().uuid().describe("Issue ID"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
        status: z.string().optional().describe("New status"),
      },
      async ({ issueId, title, description, status }) => {
        return handleWithAudit(db, claims, "updateIssue", CAP_BOARD_WRITE, async () => {
          requireCapability(claims, CAP_BOARD_WRITE, "updateIssue");
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ issue: null, issueId, title, description, status }),
              },
            ],
          };
        });
      },
    );
  }

  return server;
}

// ─── Gateway self-registration ───────────────────────────────────────────────

const COCKPIT_MCP_GATEWAY_NAME = "cockpit-mcp";

/**
 * Self-register the cockpit MCP server with the APEX gateway on boot.
 * Idempotent: a 409 conflict means it is already registered, which is fine.
 * Failure is non-fatal; the cockpit continues to boot without gateway
 * registration (degraded: external hosts won't discover tools through
 * the gateway, but dispatched runs still work directly).
 */
export async function registerCockpitMcpWithGateway(serverPort: number): Promise<void> {
  const mcpUrl =
    process.env.PAPERCLIP_COCKPIT_MCP_URL?.trim() || `http://127.0.0.1:${serverPort}/mcp`;
  const client = new GatewayClient();
  const result = await client.registerGateway({
    name: COCKPIT_MCP_GATEWAY_NAME,
    url: mcpUrl,
    transport: "STREAMABLEHTTP",
    description: "Cockpit MCP server — board APIs with run-scoped identity",
  });
  if (result.ok) {
    logger.info({ mcpUrl, gatewayId: result.id }, "cockpit-mcp registered with APEX gateway");
  } else if (result.status === "conflict") {
    logger.info({ mcpUrl }, "cockpit-mcp already registered with APEX gateway");
  } else {
    logger.warn({ mcpUrl, status: result.status, message: result.message }, "cockpit-mcp gateway registration failed (non-fatal)");
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function mcpRoutes(db: Db): Router {
  const router = Router();

  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    // T2 — Run-JWT auth middleware
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const verifyResult = verifyCockpitMcpJwt(token);

    if (!verifyResult.ok) {
      const status =
        verifyResult.reason === "wrong_audience" || verifyResult.reason === "bad_signature"
          ? 401
          : 401;
      res.status(status).json({ error: "Unauthorized", reason: verifyResult.reason });
      return;
    }

    const claims = verifyResult.claims;
    const server = buildMcpServer(db, claims);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err, runId: claims.run_id }, "MCP request handling failed");
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    } finally {
      // Clean up the server connection after each stateless request
      await server.close().catch(() => {});
    }
  }

  router.post("/mcp", (req, res, next) => {
    handleMcpRequest(req, res).catch(next);
  });

  router.get("/mcp", (req, res, next) => {
    handleMcpRequest(req, res).catch(next);
  });

  router.delete("/mcp", (req, res, next) => {
    handleMcpRequest(req, res).catch(next);
  });

  return router;
}
