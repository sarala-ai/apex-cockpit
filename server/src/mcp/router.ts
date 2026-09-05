/**
 * Cockpit MCP server — streamable-HTTP transport mounted at /mcp.
 *
 * Identity model:
 *   - Dispatched runs: bearer JWT with aud "cockpit-mcp", minted at dispatch.
 *   - Chat-panel: same JWT bearer, capability set restricted to draft:write.
 *   - External hosts: OAuth 2.1 + PKCE (T7, see ./oauth.ts) — the access token
 *     is a user-scoped cockpit-mcp JWT verified by the same middleware.
 *   - Cockpit-issued principal JWTs (EdDSA, aud "apex-gateway", verified with
 *     this instance's own JWKS — auth/verify-principal-jwt.ts), as the gateway
 *     presents them when it federates cockpit-mcp:
 *       · gateway-federation principal: the credential the gateway holds for
 *         its registration probe / health check / catalog sync. Probe surface
 *         only (FEDERATION_PROBE_METHODS); a tool call is 403.
 *       · operator principal: forwarded by the gateway on tool calls, or
 *         presented directly. Authorized as that operator — a board user with
 *         their companies, resolved from the DB like the REST actor — with
 *         board:read; board writes stay run-attributed (requireRunIdentity).
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
import { activityLog, issues } from "@paperclipai/db";
import { and, asc, eq, ilike } from "drizzle-orm";
import { verifyCockpitMcpJwt, type CockpitMcpJwtClaims } from "./cockpit-mcp-jwt.js";
import type { GatewayClient, GatewayWriteResult } from "../gateway/gateway-client.js";
import { cockpitSystemGatewayClient } from "../gateway/system-credential.js";
import { gatewayFederationToken } from "./federation-credential.js";
import { jwtExpiryMs, type TokenSource } from "../auth/mint-system-jwt.js";
import {
  decodeJwtHeader,
  jwtIssuer,
  type PrincipalJwtVerifier,
  type VerifiedPrincipal,
} from "../auth/verify-principal-jwt.js";
import { logger } from "../middleware/logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { issueService } from "../services/issues.js";
import { logActivity, secretService } from "../services/index.js";
import {
  CAP_BOARD_READ,
  CAP_BOARD_WRITE,
  CAP_DRAFT_WRITE,
  CAP_SECRETS_WRITE,
  CapabilityDeniedError,
  requireCapability,
} from "./capabilities.js";
import {
  listSecretDefinitions,
  provisionSecret,
  MINT_PROVIDERS,
  SECRETS_LIST_DEFINITIONS_TOOL,
  SECRETS_PROVISION_TOOL,
  type SecretsPort,
} from "./secrets-tools.js";

// ─── Capabilities ────────────────────────────────────────────────────────────
// Defined in ./capabilities.ts (cockpit-mcp-jwt.ts needs them too and cannot
// import this module without closing a cycle); re-exported here because that is
// where every existing importer looks for them.

export {
  CAP_BOARD_READ,
  CAP_BOARD_WRITE,
  CAP_DRAFT_WRITE,
  CAP_SECRETS_WRITE,
};

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
  // The federation principal belongs to no company, and activity rows are
  // company-scoped; its probes are logged, not audited.
  if (input.claims.token_kind === "gateway_federation") {
    logger.debug({ tool: input.tool, outcome: input.outcome }, "cockpit-mcp federation probe");
    return;
  }
  const isUser = input.claims.token_kind === "user";
  try {
    await db.insert(activityLog).values({
      companyId: input.claims.company_id,
      actorType: isUser ? "user" : "agent",
      actorId: input.claims.sub,
      action: "mcp_tool_call",
      entityType: "mcp_tool",
      entityId: input.tool,
      agentId: isUser ? null : input.claims.sub,
      runId: input.claims.run_id,
      details: {
        tool: input.tool,
        requiredCapability: input.requiredCapability,
        outcome: input.outcome,
        runId: input.claims.run_id,
        userId: input.claims.user_id,
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

/**
 * Board writes attribute to an agent + run (FK columns); user-scoped OAuth
 * tokens carry neither, so writes stay denied even if such a token were ever
 * minted with board:write.
 */
function requireRunIdentity(
  claims: CockpitMcpJwtClaims,
  tool: string,
): { agentId: string; runId: string } {
  if (claims.token_kind !== "run" || !claims.run_id) {
    throw new CapabilityDeniedError(tool, "run-identity");
  }
  return { agentId: claims.sub, runId: claims.run_id };
}

// draft:write auto-attenuation: tools excluded from draft-write sessions
const DRAFT_WRITE_EXCLUDED_TOOLS = new Set([
  "updateIssue", // status transitions require board:write
  // Credential provisioning is never part of a draft-write (chat-panel)
  // session, whatever else that session was granted. Hiding them from
  // tools/list is cosmetic — the capability gate is the real lock — but a tool
  // the model cannot see is a tool it does not try to talk its way into.
  SECRETS_LIST_DEFINITIONS_TOOL,
  SECRETS_PROVISION_TOOL,
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

  const svc = issueService(db);

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
        const conditions = [eq(issues.companyId, claims.company_id)];
        if (projectId) conditions.push(eq(issues.projectId, projectId));
        if (status) conditions.push(eq(issues.status, status));
        const rows = await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            projectId: issues.projectId,
            assigneeAgentId: issues.assigneeAgentId,
            createdAt: issues.createdAt,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .where(and(...conditions))
          .orderBy(asc(issues.createdAt))
          .limit(limit ?? 50);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ issues: rows }) }],
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
        const issue = await svc.getById(issueId);
        if (!issue || issue.companyId !== claims.company_id) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found" }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ issue }) }],
        };
      });
    },
  );

  server.tool(
    "listComments",
    "List comments on an issue",
    {
      issueId: z.string().uuid().describe("Issue ID"),
      limit: z.number().int().min(1).max(200).optional().default(50),
    },
    async ({ issueId, limit }) => {
      return handleWithAudit(db, claims, "listComments", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "listComments");
        // verify issue belongs to this company
        const issue = await db
          .select({ companyId: issues.companyId })
          .from(issues)
          .where(and(eq(issues.id, issueId), eq(issues.companyId, claims.company_id)))
          .then((rows) => rows[0] ?? null);
        if (!issue) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found" }) }],
            isError: true,
          };
        }
        const comments = await svc.listComments(issueId, { order: "asc", limit });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ comments }) }],
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
        const runIdentity = requireRunIdentity(claims, "createComment");
        const comment = await svc.addComment(issueId, body, runIdentity);
        if (!comment) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found" }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ comment }) }],
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
        const runIdentity = requireRunIdentity(claims, "createIssue");
        const issue = await svc.create(claims.company_id, {
          title,
          description: description ?? null,
          projectId: projectId ?? null,
          actorRunId: runIdentity.runId,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ issue }) }],
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
          const runIdentity = requireRunIdentity(claims, "updateIssue");
          const existing = await svc.getById(issueId);
          if (!existing || existing.companyId !== claims.company_id) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: "Issue not found" }) }],
              isError: true,
            };
          }
          const patch: Record<string, unknown> = { actorAgentId: runIdentity.agentId };
          if (title !== undefined) patch.title = title;
          if (description !== undefined) patch.description = description;
          if (status !== undefined) patch.status = status;
          const issue = await svc.update(issueId, patch);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ issue }) }],
          };
        });
      },
    );
  }

  // Secret provisioning (secrets:write)
  //
  // Registered on the same terms as every other tool — the capability gate
  // inside the handler is the lock, and an ungranted call must produce the
  // standard "capability … required for tool …" denial plus its audit row, not
  // a confusing "unknown tool". Visibility is attenuated only for draft-write
  // sessions (DRAFT_WRITE_EXCLUDED_TOOLS above).
  if (
    isToolVisibleForClaims(SECRETS_LIST_DEFINITIONS_TOOL, claims) &&
    isToolVisibleForClaims(SECRETS_PROVISION_TOOL, claims)
  ) {
    const secretsPort: SecretsPort = secretService(db);
    const secretsDeps = {
      claims,
      secrets: secretsPort,
      recordActivity: (input: Parameters<typeof logActivity>[1]) => logActivity(db, input),
    };

    server.tool(
      SECRETS_LIST_DEFINITIONS_TOOL,
      "List the company's user-secret definitions and whether YOU have a value stored for each. Never returns secret values.",
      {
        companyId: z.string().uuid().describe("Company ID (must match the session's company)"),
      },
      async ({ companyId }) => {
        return handleWithAudit(db, claims, SECRETS_LIST_DEFINITIONS_TOOL, CAP_SECRETS_WRITE, async () => {
          const result = await listSecretDefinitions(secretsDeps, { companyId });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        });
      },
    );

    server.tool(
      SECRETS_PROVISION_TOOL,
      "Mint a credential at its provider AND store it in the secret store in one server-side step. " +
        "Returns metadata only — the value never leaves the server. Provisioning a definition that " +
        "already has a value rotates it to a new version.",
      {
        companyId: z.string().uuid().describe("Company ID (must match the session's company)"),
        definitionKey: z
          .string()
          .min(1)
          .describe("User-secret definition key, e.g. PENPOT_ACCESS_TOKEN"),
        provider: z
          .enum(MINT_PROVIDERS)
          .optional()
          .describe("Mint provider; inferred from the definition key when omitted"),
        tokenName: z
          .string()
          .min(1)
          .optional()
          .describe("Label shown on the provider side; defaults to an identifiable cockpit label"),
        expiresAt: z
          .string()
          .optional()
          .describe(
            "ISO-8601 expiry. Omit (the default) for a non-expiring, revocable credential — " +
              "an agent credential that expires mid-run fails as a confusing 401 inside somebody else's work.",
          ),
      },
      async ({ companyId, definitionKey, provider, tokenName, expiresAt }) => {
        return handleWithAudit(db, claims, SECRETS_PROVISION_TOOL, CAP_SECRETS_WRITE, async () => {
          const result = await provisionSecret(secretsDeps, {
            companyId,
            definitionKey,
            provider,
            tokenName,
            expiresAt,
          });
          // `result` is a ProvisionResult and nothing else — see its doc
          // comment. Do not widen this to spread a service row.
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        });
      },
    );
  }

  return server;
}

// ─── Gateway self-registration ───────────────────────────────────────────────

export const COCKPIT_MCP_GATEWAY_NAME = "cockpit-mcp";

export interface CockpitMcpUrlInput {
  serverPort: number;
  /** Cockpit's public base URL (PAPERCLIP_PUBLIC_URL); the MCP URL the
   *  gateway must dial on a hosted deployment, where loopback is the
   *  gateway's own container. */
  publicUrl?: string | null;
  deploymentMode: "local_trusted" | "authenticated";
  explicitUrl?: string | null;
}

/** The URL the gateway registers for cockpit-mcp. An explicit
 *  PAPERCLIP_COCKPIT_MCP_URL always wins; hosted (authenticated) instances
 *  derive it from their public URL; local instances use loopback. */
export function resolveCockpitMcpUrl(input: CockpitMcpUrlInput): string {
  const explicit = input.explicitUrl?.trim();
  if (explicit) return explicit;
  const publicBase = input.publicUrl?.trim().replace(/\/+$/, "");
  if (input.deploymentMode === "authenticated" && publicBase) return `${publicBase}/mcp`;
  return `http://127.0.0.1:${input.serverPort}/mcp`;
}

/**
 * POST /gateways makes apex-gateway itself dial the upstream url and run an
 * MCP initialize handshake before it answers (gateway_service.py
 * register_gateway → _initialize_gateway_with_timeout). The route that calls
 * it (mcpgateway/main.py register_gateway) never passes `initialize_timeout`,
 * so that handshake is NOT wrapped in `asyncio.wait_for` and is bounded only
 * by the gateway's own federation_timeout (120s, config.py). The cockpit's
 * default write timeout (gateway-client.ts timedWrite, 8s) is far shorter,
 * so cockpit gives up and reports "unreachable" long before the gateway's
 * attempt against cockpit's own /mcp resolves either way. Give this specific
 * call enough room to outlast that 120s ceiling.
 */
const REGISTER_TIMEOUT_MS = 130_000;

export type CockpitMcpRegistrationOutcome =
  | "registered"
  | "repointed"
  | "credential_refreshed"
  | "already_registered"
  | "skipped_placeholder"
  | "rejected_credential"
  | "upstream_auth_required"
  | "gateway_unreachable"
  | "failed";

export interface CockpitMcpRegistrationResult {
  outcome: CockpitMcpRegistrationOutcome;
  mcpUrl: string;
  message: string;
  /** Expiry (ms) of the federation token this attempt stored at the gateway;
   *  null when it wrote one without a readable `exp`; absent when the attempt
   *  stored no credential (no token source, or nothing was written). The
   *  sweep uses it to refresh before expiry. */
  credentialExpiresAt?: number | null;
}

/**
 * `upstream_unreachable` (POST/PUT /gateways got a 502) means apex-gateway
 * reached cockpit's own /mcp but the initialize probe was refused. With a
 * federation credential registered that is no longer expected — it now means
 * the credential was rejected (expired between mint and probe, JWKS out of
 * step, or a cockpit build that predates principal verification at /mcp).
 * Without one (local_trusted instances have no signer) it is the known
 * shape of the probe arriving with no credential at all.
 */
function classifyRegistrationFailure(
  mcpUrl: string,
  result: Extract<GatewayWriteResult, { ok: false }>,
  credentialPresented: boolean,
): CockpitMcpRegistrationResult {
  if (result.status === "auth") {
    return {
      outcome: "rejected_credential",
      mcpUrl,
      message: `apex-gateway rejected the cockpit system principal: ${result.message}`,
    };
  }
  if (result.status === "upstream_unreachable") {
    return {
      outcome: "upstream_auth_required",
      mcpUrl,
      message: credentialPresented
        ? `apex-gateway reached cockpit's own /mcp endpoint but its probe was refused (${result.message}). ` +
          `The gateway-federation token was registered as the upstream credential, so this is a verification ` +
          `failure at cockpit's /mcp (expired token, JWKS/issuer mismatch), not a reachability problem.`
        : `apex-gateway reached cockpit's own /mcp endpoint but could not complete the connection (${result.message}). ` +
          `cockpit's /mcp requires a JWT and this instance minted no gateway-federation credential to register ` +
          `(no principal signer on a local_trusted instance), so the probe arrived unauthenticated.`,
    };
  }
  if (result.status === "unreachable" || result.status === "credential_unavailable") {
    return { outcome: "gateway_unreachable", mcpUrl, message: result.message };
  }
  return { outcome: "failed", mcpUrl, message: result.message };
}

export interface CockpitMcpRegistrationOptions {
  /** Mints the upstream credential the gateway stores for cockpit-mcp
   *  (mintGatewayFederationJwt). Defaults to the process-level source; null
   *  from it means "register without a credential", the local contract. */
  federationToken?: TokenSource;
  /** When cockpit-mcp is already registered at the right URL: re-point it
   *  anyway with a fresh federation token (default true — a fresh process
   *  cannot know how stale the stored one is). The sweep passes false on the
   *  ticks where its own record says the credential is still fresh. */
  refreshCredential?: boolean;
}

interface FederationCredential {
  token: string;
  /** `iss` of the minted token — the value the gateway pins the caller's
   *  forwarded JWT against (oauth_config.issuer). Omitted for loopback
   *  issuers, which the gateway's URL validator refuses; the gateway then
   *  forwards any non-hub JWS, which on a local instance is only ever
   *  cockpit's own. */
  issuer: string | null;
  expiresAt: number | null;
}

function isLoopbackIssuer(issuer: string): boolean {
  try {
    const host = new URL(issuer).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host === "0.0.0.0";
  } catch {
    return true;
  }
}

async function mintFederationCredential(source: TokenSource): Promise<FederationCredential | null> {
  const token = await source();
  if (!token) return null;
  const issuer = jwtIssuer(token);
  return { token, issuer: issuer && !isLoopbackIssuer(issuer) ? issuer : null, expiresAt: jwtExpiryMs(token) };
}

/** The auth fields of a cockpit-mcp registration: the federation token as the
 *  stored bearer, and the gateway's static-login-passthrough opt-in so an
 *  operator's own principal JWT supersedes it on tool calls
 *  (gateway_auth_service.static_login_passthrough_bearer). */
function federationAuthFields(credential: FederationCredential) {
  return {
    authType: "bearer" as const,
    authToken: credential.token,
    oauthConfig: {
      login_passthrough: true,
      ...(credential.issuer ? { issuer: credential.issuer } : {}),
    },
  };
}

/**
 * Self-register the cockpit MCP server with the APEX gateway, as the cockpit
 * system principal, handing the gateway a gateway-federation token as the
 * credential it presents back to cockpit's /mcp. Called once at boot
 * (fire-and-forget) and, on retry, by `startCockpitMcpRegistrationSweep`
 * (registration-sweep.ts) and the manual `POST /setup/mcp/register` route —
 * all three go through this one function so every caller sees the same
 * classification. Idempotent: a 409 conflict means a gateway already exists
 * under this name — if its registered url no longer matches the resolved one
 * (e.g. a stale loopback or placeholder URL from an earlier deploy pass), or
 * its credential is due for refresh, it is repointed via PUT. Never throws:
 * callers get a classified result instead, so a down/slow gateway degrades
 * this to a retryable outcome rather than crashing boot.
 */
export async function registerCockpitMcpWithGateway(
  input: Omit<CockpitMcpUrlInput, "explicitUrl">,
  client: GatewayClient = cockpitSystemGatewayClient(),
  opts: CockpitMcpRegistrationOptions = {},
): Promise<CockpitMcpRegistrationResult> {
  const mcpUrl = resolveCockpitMcpUrl({ ...input, explicitUrl: process.env.PAPERCLIP_COCKPIT_MCP_URL });
  let hostname: string | null = null;
  try {
    hostname = new URL(mcpUrl).hostname;
  } catch {
    hostname = null;
  }
  if (hostname === "placeholder.invalid") {
    return {
      outcome: "skipped_placeholder",
      mcpUrl,
      message: "PAPERCLIP_PUBLIC_URL is still the deploy placeholder (will register on the next deploy pass)",
    };
  }
  let credential: FederationCredential | null;
  try {
    credential = await mintFederationCredential(opts.federationToken ?? gatewayFederationToken);
  } catch (err) {
    return {
      outcome: "gateway_unreachable",
      mcpUrl,
      message: `cockpit could not mint the gateway-federation credential: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = await client.registerGateway({
    name: COCKPIT_MCP_GATEWAY_NAME,
    url: mcpUrl,
    transport: "STREAMABLEHTTP",
    description: "Cockpit MCP server — board APIs with run-scoped identity",
    timeoutMs: REGISTER_TIMEOUT_MS,
    ...(credential ? federationAuthFields(credential) : {}),
  });
  if (result.ok) {
    return {
      outcome: "registered",
      mcpUrl,
      message: `registered with APEX gateway (id=${result.id ?? "?"})`,
      ...(credential ? { credentialExpiresAt: credential.expiresAt } : {}),
    };
  }
  if (result.status === "conflict") {
    return repointExistingCockpitMcpGateway(mcpUrl, client, credential, opts.refreshCredential ?? true);
  }
  return classifyRegistrationFailure(mcpUrl, result, credential !== null);
}

/**
 * A 409 on POST /gateways means a gateway named cockpit-mcp already exists.
 * Read it back and, if its url has drifted from the desired one or its
 * stored federation credential is due, repoint it with PUT rather than
 * leaving the stale registration in place.
 */
async function repointExistingCockpitMcpGateway(
  mcpUrl: string,
  client: GatewayClient,
  credential: FederationCredential | null,
  refreshCredential: boolean,
): Promise<CockpitMcpRegistrationResult> {
  const existing = await client.readGateways();
  if (!existing.ok) {
    return {
      outcome: "failed",
      mcpUrl,
      message: `already registered with APEX gateway, but could not read it back to check for drift: ${existing.failure.message}`,
    };
  }
  const entry = existing.value.find((g) => g.name === COCKPIT_MCP_GATEWAY_NAME);
  if (!entry) {
    return { outcome: "failed", mcpUrl, message: "registration conflicted (409) but no gateway with that name was found on read-back" };
  }
  const urlCurrent = entry.url === mcpUrl;
  const refresh = credential !== null && refreshCredential;
  if (urlCurrent && !refresh) {
    return { outcome: "already_registered", mcpUrl, message: "already registered with APEX gateway" };
  }
  if (!entry.id) {
    return { outcome: "failed", mcpUrl, message: `registration is stale (previous url ${entry.url}) but has no id to update` };
  }
  const update = await client.updateGateway(entry.id, {
    url: mcpUrl,
    timeoutMs: REGISTER_TIMEOUT_MS,
    ...(credential ? federationAuthFields(credential) : {}),
  });
  if (update.ok) {
    const credentialExpiresAt = credential ? { credentialExpiresAt: credential.expiresAt } : {};
    return urlCurrent
      ? { outcome: "credential_refreshed", mcpUrl, message: "refreshed the gateway-federation credential", ...credentialExpiresAt }
      : { outcome: "repointed", mcpUrl, message: `repointed from ${entry.url} to current URL`, ...credentialExpiresAt };
  }
  return classifyRegistrationFailure(mcpUrl, update, credential !== null);
}

// ─── Principal JWT → MCP identity ────────────────────────────────────────────

/**
 * The JSON-RPC methods the gateway-federation principal may call: what a
 * registration probe, health check and catalog sync need, and nothing that
 * executes. Anything else — tools/call above all — is refused before the
 * MCP server is even built.
 */
export const FEDERATION_PROBE_METHODS: ReadonlySet<string> = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
]);

const COMPANY_HEADER = "x-paperclip-company-id";

export function federationClaims(principal: VerifiedPrincipal): CockpitMcpJwtClaims {
  return {
    sub: principal.sub,
    token_kind: "gateway_federation",
    company_id: "",
    run_id: null,
    user_id: null,
    adapter_type: null,
    granted_capabilities: [],
    issue_id: null,
    case_id: null,
    project_id: null,
    iat: 0,
    exp: principal.exp,
    iss: principal.iss ?? "",
    aud: "apex-gateway",
    instance_id: "",
  };
}

type OperatorClaimsResult =
  | { ok: true; claims: CockpitMcpJwtClaims }
  | { ok: false; status: 401 | 403; reason: "unknown_user" | "no_company" | "ambiguous_company" | "company_forbidden" };

/**
 * An operator principal becomes a user-kind MCP identity for ONE company —
 * the tools are company-scoped. The company is, in order: an explicit
 * `X-Paperclip-Company-Id` header the operator is a member of (or any, for
 * an instance admin), the token's unambiguous `companyId`, or the single
 * company the DB says they belong to. More than one and no selection is a
 * 403 the caller can fix, never a silent guess.
 */
export async function resolveOperatorClaims(
  db: Db,
  principal: VerifiedPrincipal,
  requestedCompanyId: string | null,
): Promise<OperatorClaimsResult> {
  const access = await boardAuthService(db).resolveBoardAccess(principal.sub);
  if (!access.user) return { ok: false, status: 401, reason: "unknown_user" };
  const memberOf = new Set(access.companyIds);

  let companyId: string | null = null;
  if (requestedCompanyId) {
    if (!memberOf.has(requestedCompanyId) && !access.isInstanceAdmin) {
      return { ok: false, status: 403, reason: "company_forbidden" };
    }
    companyId = requestedCompanyId;
  } else if (principal.companyId && memberOf.has(principal.companyId)) {
    companyId = principal.companyId;
  } else if (memberOf.size === 1) {
    companyId = access.companyIds[0]!;
  } else if (memberOf.size === 0) {
    return { ok: false, status: 403, reason: "no_company" };
  } else {
    return { ok: false, status: 403, reason: "ambiguous_company" };
  }

  return {
    ok: true,
    claims: {
      sub: principal.sub,
      token_kind: "user",
      company_id: companyId,
      run_id: null,
      user_id: principal.sub,
      adapter_type: null,
      // Reads only: every board write attributes to an agent + run
      // (requireRunIdentity), which an operator token cannot supply.
      granted_capabilities: [CAP_BOARD_READ],
      issue_id: null,
      case_id: null,
      project_id: null,
      iat: 0,
      exp: principal.exp,
      iss: principal.iss ?? "",
      aud: "apex-gateway",
      instance_id: "",
    },
  };
}

function rpcMethodsOf(body: unknown): string[] {
  const items = Array.isArray(body) ? body : [body];
  return items
    .map((item) => (item && typeof item === "object" ? (item as { method?: unknown }).method : undefined))
    .filter((m): m is string => typeof m === "string");
}

// ─── Router ───────────────────────────────────────────────────────────────────

export interface McpRoutesOptions {
  /** Verifies cockpit-issued principal JWTs (auth/verify-principal-jwt.ts).
   *  Absent on local_trusted instances, which issue none — only run/user
   *  tokens are then accepted, as before. */
  principalJwtVerifier?: PrincipalJwtVerifier;
}

export function mcpRoutes(db: Db, opts: McpRoutesOptions = {}): Router {
  const router = Router();

  async function authenticate(req: Request, res: Response): Promise<CockpitMcpJwtClaims | null> {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

    // The two token families are told apart by algorithm: run/user tokens are
    // HS256 (cockpit-mcp-jwt.ts), principal tokens EdDSA (the jwt plugin).
    if (token && opts.principalJwtVerifier && decodeJwtHeader(token)?.alg === "EdDSA") {
      const verified = await opts.principalJwtVerifier.verify(token);
      if (!verified.ok) {
        res.status(401).json({ error: "Unauthorized", reason: verified.reason });
        return null;
      }
      const principal = verified.principal;
      if (principal.principalKind === "gateway_federation") {
        if (req.method === "POST") {
          const methods = rpcMethodsOf(req.body);
          const refused = methods.length === 0 ? "(none)" : (methods.find((m) => !FEDERATION_PROBE_METHODS.has(m)) ?? null);
          if (refused !== null) {
            res.status(403).json({ error: "Forbidden", reason: "federation_probe_only", method: refused });
            return null;
          }
        }
        return federationClaims(principal);
      }
      if (principal.principalKind === "cockpit_system") {
        // Cockpit does not call its own MCP surface as itself.
        res.status(403).json({ error: "Forbidden", reason: "principal_not_permitted" });
        return null;
      }
      const header = req.header(COMPANY_HEADER)?.trim() || null;
      const operator = await resolveOperatorClaims(db, principal, header);
      if (!operator.ok) {
        res.status(operator.status).json({ error: operator.status === 401 ? "Unauthorized" : "Forbidden", reason: operator.reason });
        return null;
      }
      return operator.claims;
    }

    // T2 — Run-JWT auth middleware
    const verifyResult = verifyCockpitMcpJwt(token);
    if (!verifyResult.ok) {
      res.status(401).json({ error: "Unauthorized", reason: verifyResult.reason });
      return null;
    }
    return verifyResult.claims;
  }

  async function handleMcpRequest(req: Request, res: Response): Promise<void> {
    const claims = await authenticate(req, res);
    if (!claims) return;
    const server = buildMcpServer(db, claims);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      // tools/list is served inside the SDK, so it can't go through
      // handleWithAudit — audit it here to keep "every call writes a row".
      const rpcMethod = (req.body as { method?: unknown } | undefined)?.method;
      if (rpcMethod === "tools/list") {
        await writeAuditRow(db, {
          claims,
          tool: "tools/list",
          requiredCapability: "none",
          outcome: "ok",
        });
      }
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
