/**
 * Cockpit MCP server — streamable-HTTP transport mounted at /mcp.
 *
 * Identity model:
 *   - Dispatched runs: bearer JWT with aud "cockpit-mcp", minted at dispatch.
 *   - Chat-panel: same JWT bearer, capability set restricted to draft:write.
 *   - External hosts: OAuth 2.1 + PKCE (T7, see ./oauth.ts) — the access token
 *     is a user-scoped cockpit-mcp JWT verified by the same middleware.
 *   - Cockpit-issued operator principal JWTs (EdDSA, aud "apex-gateway",
 *     verified with this instance's own JWKS — auth/verify-principal-jwt.ts),
 *     as the gateway forwards them: cockpit-mcp is a built-in upstream of the
 *     gateway (derived from COCKPIT_PUBLIC_URL there) with no stored
 *     credential — the caller's own bearer is passed through. Authorized as
 *     that operator — a board user with their companies, resolved from the DB
 *     like the REST actor — with board:read; board writes stay run-attributed
 *     (requireRunIdentity).
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
import { activityLog, companies, issues } from "@paperclipai/db";
import { and, asc, eq, ilike } from "drizzle-orm";
import { getSurface } from "@paperclipai/shared";
import { verifyCockpitMcpJwt, type CockpitMcpJwtClaims } from "./cockpit-mcp-jwt.js";
import { decodeJwtHeader, type PrincipalJwtVerifier, type VerifiedPrincipal } from "../auth/verify-principal-jwt.js";
import { logger } from "../middleware/logger.js";
import { boardAuthService } from "../services/board-auth.js";
import { issueService } from "../services/issues.js";
import { logActivity, secretService } from "../services/index.js";
import { computeOrgFacts } from "../services/org-facts.js";
import { surfaceFlagsService, type SurfaceListEntry } from "../services/surface-flags.js";
import { WorkflowsCliClient } from "../apex/workflows-cli.js";
import { DocsCliClient } from "../apex/docs-cli.js";
import {
  CAP_BOARD_READ,
  CAP_BOARD_WRITE,
  CAP_DRAFT_WRITE,
  CAP_SECRETS_WRITE,
  CAP_VEIL_WRITE,
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
  CAP_VEIL_WRITE,
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

// ─── Veil (org-facts / surfaces / suggest_next / docs) tool support ──────────

/** `companies.orgId` + `companies.issuePrefix`, resolved once per Veil tool
 *  call. `issuePrefix` doubles as the URL `companyPrefix` segment (App.tsx
 *  matches it case-insensitively) AND, lowercased, as the `apex` CLI's
 *  `APEX_COMPANY_SLUG` (see resolveCompanySlug in routes/apex-workflows.ts —
 *  reused here rather than re-deriving it, so the two can never drift). */
async function resolveCompanyContext(
  db: Db,
  companyId: string,
): Promise<{ orgId: string; companyPrefix: string } | null> {
  const rows = await db
    .select({ orgId: companies.orgId, issuePrefix: companies.issuePrefix })
    .from(companies)
    .where(eq(companies.id, companyId));
  const row = rows[0];
  if (!row || !row.orgId) return null;
  return { orgId: row.orgId, companyPrefix: row.issuePrefix };
}

/** Actor attribution for a Veil write (set_surface_veil): a run token
 *  attributes to its run, an operator/user token to its user. Never both —
 *  the two token kinds are mutually exclusive by construction
 *  (cockpit-mcp-jwt.ts). */
function veilActor(claims: CockpitMcpJwtClaims): { actorUserId: string | null; actorRunId: string | null } {
  if (claims.token_kind === "run") return { actorUserId: null, actorRunId: claims.run_id };
  return { actorUserId: claims.user_id, actorRunId: null };
}

const SUGGEST_NEXT_ACTION_SCHEMA = z.object({
  kind: z.enum(["workflow", "route", "consent"]),
  href: z.string().min(1),
});

const SUGGEST_NEXT_ITEM_SCHEMA = z.object({
  surfaceKey: z.string().optional(),
  workflow: z.object({ name: z.string() }).optional(),
  // REQUIRED, deliberately: a suggestion with no action is prose, not a
  // suggestion, and this schema makes that shape impossible to return.
  action: SUGGEST_NEXT_ACTION_SCHEMA,
  why: z.string().min(1),
});
type SuggestNextItem = z.infer<typeof SUGGEST_NEXT_ITEM_SCHEMA>;
const SUGGEST_NEXT_OUTPUT_SHAPE = { suggestions: z.array(SUGGEST_NEXT_ITEM_SCHEMA) };

/**
 * Deterministic "what should I look at next" list — no model call, no
 * ranking heuristic beyond registry stage order. Two sources, concatenated:
 *
 *   1. Surfaces the due() rules already consider relevant (`visible: true`)
 *      that have never been given an explicit flag yet — i.e. freshly due,
 *      nothing has pointed the operator at them yet. Sorted by stage, then
 *      registry order.
 *   2. Up to 3 workflows from the catalog (WorkflowsCliClient.list) the
 *      operator hasn't necessarily run — surfaced as-is; `run_workflow`
 *      resolves the actual href for one of these by name.
 *
 * A CLI that can't answer (missing/unreleased) degrades this to surfaces
 * only — never throws, since "no workflow catalog available yet" is not a
 * reason to withhold the surfaces half of the answer.
 */
async function buildSuggestNext(
  db: Db,
  facts: Awaited<ReturnType<typeof computeOrgFacts>>,
  ctx: { orgId: string; companyPrefix: string },
): Promise<SuggestNextItem[]> {
  const suggestions: SuggestNextItem[] = [];

  const surfaceList = await surfaceFlagsService(db).list(ctx.orgId, facts, false);
  const freshlyDue = surfaceList
    .filter((s) => !s.always && s.visible && s.flag === null)
    .sort((a, b) => a.stage - b.stage);
  for (const s of freshlyDue) {
    suggestions.push({
      surfaceKey: s.key,
      action: { kind: "route", href: `/${ctx.companyPrefix}/${s.navPath.replace(/^\//, "")}` },
      why: s.due.reason,
    });
  }

  const workflowsClient = new WorkflowsCliClient();
  const companySlug = ctx.companyPrefix.toLowerCase();
  const workflowsResult = await workflowsClient.list(companySlug);
  if (workflowsResult.ok) {
    for (const wf of workflowsResult.data.workflows.slice(0, 3)) {
      suggestions.push({
        workflow: { name: wf.name },
        action: { kind: "workflow", href: `/${ctx.companyPrefix}/workflows/${wf.name}` },
        why: `workflow "${wf.name}" is in the catalog (${wf.lifecycle})`,
      });
    }
  }

  return suggestions;
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

  // ─── Veil tools (org facts, surfaces, suggest_next, docs) ────────────────
  //
  // company_id on every claims shape resolves to exactly one org — a run or
  // operator token is always scoped to one company, and a company belongs to
  // at most one org (companies.orgId) — so every tool below resolves that
  // pair once per call rather than trusting a caller-supplied orgId.

  server.tool(
    "get_org_facts",
    "Get the raw OrgFacts snapshot (the Veil) for the authenticated session's org: repo/cloud bindings, " +
      "run counts, open PRs, deploys, gateway audit coverage, membership + goal counts, operator auth health.",
    {},
    async () => {
      return handleWithAudit(db, claims, "get_org_facts", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "get_org_facts");
        const ctx = await resolveCompanyContext(db, claims.company_id);
        if (!ctx) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "company has no org" }) }],
            isError: true,
          };
        }
        const facts = await computeOrgFacts(db, { orgId: ctx.orgId, userId: claims.user_id });
        return { content: [{ type: "text" as const, text: JSON.stringify({ facts }) }] };
      });
    },
  );

  server.tool(
    "list_surfaces",
    "List every nav surface in the Veil registry for the authenticated session's org, merged with its " +
      "persisted unveil flags and live due() verdicts (key, label, section, stage, due, reason, visible).",
    {},
    async () => {
      return handleWithAudit(db, claims, "list_surfaces", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "list_surfaces");
        const ctx = await resolveCompanyContext(db, claims.company_id);
        if (!ctx) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "company has no org" }) }],
            isError: true,
          };
        }
        const facts = await computeOrgFacts(db, { orgId: ctx.orgId, userId: claims.user_id });
        // showAllSurfaces is a per-user UI debugging override (ui-preferences.ts)
        // with no meaning for a tool call — a chat/run session always sees the
        // registry's own verdict, never a human's "show me everything" toggle.
        const surfaces: SurfaceListEntry[] = await surfaceFlagsService(db).list(ctx.orgId, facts, false);
        return { content: [{ type: "text" as const, text: JSON.stringify({ surfaces }) }] };
      });
    },
  );

  server.tool(
    "set_surface_veil",
    "Explicitly unveil or re-veil one nav surface for the authenticated session's org. Always writes an " +
      "EXPLICIT flag (source \"chat\") that reconcile() will never overwrite — use this when the operator " +
      "asks to see (or hide) a surface, not for every due() surface (those unveil themselves).",
    {
      surfaceKey: z.string().min(1).describe("Registry key, e.g. \"pipelines\" — see list_surfaces for valid keys"),
      unveiled: z.boolean().describe("true to unveil, false to re-veil"),
      reason: z.string().min(1).describe("Human-readable reason, stored on the flag and its event row"),
    },
    async ({ surfaceKey, unveiled, reason }) => {
      return handleWithAudit(db, claims, "set_surface_veil", CAP_VEIL_WRITE, async () => {
        requireCapability(claims, CAP_VEIL_WRITE, "set_surface_veil");
        if (!getSurface(surfaceKey)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: `no surface "${surfaceKey}"` }) }],
            isError: true,
          };
        }
        const ctx = await resolveCompanyContext(db, claims.company_id);
        if (!ctx) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "company has no org" }) }],
            isError: true,
          };
        }
        const actor = veilActor(claims);
        const flag = await surfaceFlagsService(db).set(ctx.orgId, surfaceKey, {
          unveiled,
          reason,
          source: "chat",
          actorUserId: actor.actorUserId,
          actorRunId: actor.actorRunId,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ flag }) }] };
      });
    },
  );

  server.registerTool(
    "suggest_next",
    {
      description:
        "A deterministic \"what to look at next\" list built from the Veil registry's stage/due state plus " +
          "the apex workflow catalog — never prose-only: every item carries a clickable action " +
          "({kind:\"workflow\"|\"route\"|\"consent\", href}).",
      inputSchema: {},
      outputSchema: SUGGEST_NEXT_OUTPUT_SHAPE,
    },
    async () => {
      return handleWithAudit(db, claims, "suggest_next", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "suggest_next");
        const ctx = await resolveCompanyContext(db, claims.company_id);
        if (!ctx) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "company has no org" }) }],
            isError: true,
          };
        }
        const facts = await computeOrgFacts(db, { orgId: ctx.orgId, userId: claims.user_id });
        const suggestions = await buildSuggestNext(db, facts, ctx);
        const structuredContent = { suggestions };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      });
    },
  );

  server.tool(
    "run_workflow",
    "Point at where to run an apex workflow — this tool never executes it. Returns the existing run " +
      "surface's href and which mechanism backs it (a pipeline step vs. the apex CLI directly).",
    {
      name: z.string().min(1).describe("Workflow name, as returned by search_docs/get_guidance or `apex workflows list`"),
    },
    async ({ name }) => {
      return handleWithAudit(db, claims, "run_workflow", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "run_workflow");
        const ctx = await resolveCompanyContext(db, claims.company_id);
        if (!ctx) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "company has no org" }) }],
            isError: true,
          };
        }
        const workflowsClient = new WorkflowsCliClient();
        const result = await workflowsClient.show(name, ctx.companyPrefix.toLowerCase());
        // "pipeline_step" whenever the catalog itself can resolve the name —
        // that's the cockpit's governed run path (a pipeline stage's onEnter
        // node). A CLI that can't (missing/unreleased, or the name isn't in
        // the catalog) still gets the same href — the workflow detail page is
        // always a valid destination — but is told to fall back to the apex
        // CLI directly, since no pipeline step is known to back this name.
        const href = `/${ctx.companyPrefix}/workflows/${name}`;
        const runVia: "pipeline_step" | "cli" = result.ok ? "pipeline_step" : "cli";
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ href, runVia }) }],
        };
      });
    },
  );

  const docsClient = new DocsCliClient();

  function docsErrorResult(tool: string, error: { error_type: string; message: string; remediation?: string | null }) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: error.message, error_type: error.error_type, remediation: error.remediation ?? null }) }],
      isError: true,
    };
  }

  server.tool(
    "search_docs",
    "Tag-filter then keyword/heading-scored search over apex guidance docs (apex docs search). No vectors, " +
      "no body-embedding — filters first (kind/stage/style/entity/surface/topic), score second.",
    {
      q: z.string().min(1).describe("Search query"),
      kind: z.array(z.string()).optional(),
      stage: z.array(z.string()).optional(),
      style: z.array(z.string()).optional(),
      entity: z.array(z.string()).optional(),
      surface: z.array(z.string()).optional(),
      topic: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ q, kind, stage, style, entity, surface, topic, limit }) => {
      return handleWithAudit(db, claims, "search_docs", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "search_docs");
        const ctx = await resolveCompanyContext(db, claims.company_id);
        const companySlug = ctx?.companyPrefix.toLowerCase();
        const result = await docsClient.search(q, { kind, stage, style, entity, surface, topic, limit }, companySlug);
        if (!result.ok) return docsErrorResult("search_docs", result.error);
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] };
      });
    },
  );

  server.tool(
    "get_guidance",
    "List apex guidance docs filtered by stage/surface/entity/style (apex docs list) — the catalog view, " +
      "not a search. Use search_docs instead when you have free-text intent.",
    {
      stage: z.array(z.string()).optional(),
      surfaces: z.array(z.string()).optional().describe("Maps to --surface (repeatable)"),
      entities: z.array(z.string()).optional().describe("Maps to --entity (repeatable)"),
      styles: z.array(z.string()).optional().describe("Maps to --style (repeatable)"),
    },
    async ({ stage, surfaces, entities, styles }) => {
      return handleWithAudit(db, claims, "get_guidance", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "get_guidance");
        const ctx = await resolveCompanyContext(db, claims.company_id);
        const companySlug = ctx?.companyPrefix.toLowerCase();
        const result = await docsClient.list({ stage, surface: surfaces, entity: entities, style: styles }, companySlug);
        if (!result.ok) return docsErrorResult("get_guidance", result.error);
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] };
      });
    },
  );

  server.tool(
    "docs_tags",
    "The apex docs closed taxonomy — allowed values + observed counts for kind/stage/style/entity/surface/" +
      "status, plus open topic/workflow counts (apex docs tags). Call this before filtering search_docs/" +
      "get_guidance to discover valid values.",
    {},
    async () => {
      return handleWithAudit(db, claims, "docs_tags", CAP_BOARD_READ, async () => {
        requireCapability(claims, CAP_BOARD_READ, "docs_tags");
        const ctx = await resolveCompanyContext(db, claims.company_id);
        const companySlug = ctx?.companyPrefix.toLowerCase();
        const result = await docsClient.tags(companySlug);
        if (!result.ok) return docsErrorResult("docs_tags", result.error);
        return { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] };
      });
    },
  );

  return server;
}

// ─── Principal JWT → MCP identity ────────────────────────────────────────────

const COMPANY_HEADER = "x-paperclip-company-id";

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
      // Board reads only: every board write attributes to an agent + run
      // (requireRunIdentity), which an operator token cannot supply. veil:write
      // is the one write an operator session CAN make (set_surface_veil) — it
      // attributes to the operator's OWN user id (veilActor), not a run, so it
      // needs no run identity and is safe to grant here unconditionally.
      granted_capabilities: [CAP_BOARD_READ, CAP_VEIL_WRITE],
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
