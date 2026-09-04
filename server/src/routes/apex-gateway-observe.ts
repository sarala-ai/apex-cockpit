/**
 * Gateway governance routes — read-only views over apex-gateway's registry
 * (what's callable: gateways/tools/virtual servers), agent registry (A2A), and
 * audit ledger. Deliberately separate from apex-observe.ts: this is governance
 * data, not agent-run observability — see GatewayClient for the security
 * rationale (explicit safe field picks, never raw passthrough).
 *
 * Gateway tool-call METRICS are NOT here — they're operational health, so they
 * live under /observe/gateway-metrics in apex-observe.ts instead.
 */
import type { Request } from "express";
import { Router } from "express";
import { GatewayClient } from "../gateway/gateway-client.js";
import { EvalIngestClient } from "../observe/eval-ingest-client.js";
import { assertBoardOrAgent } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { badRequest, conflict, unprocessable, HttpError } from "../errors.js";
import { GatewayRegisterInputSchema } from "@paperclipai/shared";

const SSRF_HINT =
  "apex-gateway blocks docker-internal/private-network hosts by default (SSRF guard). " +
  "If this URL is intentionally internal (e.g. a local dev sidecar), set " +
  "SSRF_ALLOW_PRIVATE_NETWORKS=true on the gateway — dev-only, never in production.";

/** In-memory, best-effort dedup so repeated 15s polls of /gateway/audit don't
 *  re-emit an eval for the same audit entry every time (audit-trails returns
 *  the same recent window on every call, not just new events). Not persisted
 *  — resets on restart, which just means a few entries get re-evaluated once;
 *  harmless, since apex-eval evaluating the same run_id twice just produces a
 *  second (identical) EvalResult row, not a correctness issue. Capped so it
 *  can't grow unbounded over a long-running process. */
const MAX_SEEN = 5000;
const seenAuditIds = new Set<string>();
function markSeen(id: string): boolean {
  if (seenAuditIds.has(id)) return true;
  if (seenAuditIds.size >= MAX_SEEN) {
    const first = seenAuditIds.values().next().value;
    if (first !== undefined) seenAuditIds.delete(first);
  }
  seenAuditIds.add(id);
  return false;
}

export function apexGatewayObserveRoutes(
  opts: {
    /** Default/fallback client — used whenever `mintOperatorToken` is absent
     *  or resolves to null (e.g. agent/board callers with no operator
     *  session). Defaults to a fresh env-token-backed GatewayClient, same as
     *  before this option existed. Also the seam tests inject a mock client
     *  through. */
    client?: GatewayClient;
    /**
     * Mints the signed-in operator's cockpit principal JWT for this
     * request, so the gateway authorizes from the operator's own claims
     * instead of the static APEX_GATEWAY_TOKEN. Returns null when there's no
     * operator session (agent/board callers) — those fall back to `client`.
     */
    mintOperatorToken?: (req: Request) => Promise<string | null>;
  } = {},
) {
  const router = Router();
  const evalIngestClient = new EvalIngestClient();
  const defaultClient = opts.client ?? new GatewayClient();

  // Resolves the GatewayClient to use for a single request: the operator's
  // own token when available, else the shared default/fallback client.
  async function clientFor(req: Request): Promise<GatewayClient> {
    const operatorToken = (await opts.mintOperatorToken?.(req)) ?? null;
    return operatorToken ? new GatewayClient(operatorToken) : defaultClient;
  }

  // GET /gateway/registry — everything callable: upstream gateways, tools,
  // virtual servers. Grouped together since they answer the same question
  // ("what's registered/callable"), distinct from the agent registry below.
  router.get("/gateway/registry", async (req, res) => {
    assertBoardOrAgent(req);
    const client = await clientFor(req);
    const reachable = await client.reachable();
    if (!reachable) {
      res.json({ gateways: [], tools: [], servers: [], error: "gateway unreachable" });
      return;
    }
    try {
      const [gateways, tools, servers] = await Promise.all([
        client.listGateways(),
        client.listTools(),
        client.listServers(),
      ]);
      res.json({ gateways, tools, servers, error: null });
    } catch (e) {
      console.error("[gateway] registry", e);
      res.json({ gateways: [], tools: [], servers: [], error: "failed to load registry" });
    }
  });

  // POST /gateway/registry — register a new upstream MCP server. This is the
  // write path behind "Add MCP server" in the UI: what used to be a hand-run
  // curl against apex-gateway is now governed (auth-guarded the same as every
  // other write in this app) and audited (apex-gateway logs the registration
  // to its own audit trail, which shows up in GET /gateway/audit above).
  // Success also triggers federation on the gateway side — its tools show up
  // in the next /gateway/registry poll, not just the gateway entry itself.
  router.post("/gateway/registry", validate(GatewayRegisterInputSchema), async (req, res) => {
    assertBoardOrAgent(req);
    const input = req.body as {
      name: string;
      url: string;
      transport: "SSE" | "STREAMABLEHTTP" | "STDIO";
      description?: string;
    };
    if (input.transport === "STDIO") {
      // STDIO needs a `command` to spawn a subprocess, not a URL — not
      // meaningful from a browser form, so reject before even calling out.
      throw badRequest("STDIO transport requires a command and cannot be registered from the cockpit UI");
    }
    const client = await clientFor(req);
    const result = await client.registerGateway(input);
    if (result.ok) {
      res.status(201).json({ id: result.id, name: result.name });
      return;
    }
    if (result.status === "conflict") {
      throw conflict(result.message);
    }
    if (result.status === "validation") {
      throw unprocessable(`${result.message} ${SSRF_HINT}`.trim());
    }
    if (result.status === "upstream_unreachable") {
      // apex-gateway is up but couldn't connect to the registered URL — this
      // is the target server's fault, not the caller's, so 502 not 400.
      throw new HttpError(502, `apex-gateway can't reach that URL: ${result.message}`);
    }
    if (result.status === "unreachable") {
      throw new HttpError(502, "apex-gateway itself is unreachable — check APEX_GATEWAY_URL/APEX_GATEWAY_TOKEN");
    }
    if (result.status === "auth") {
      throw new HttpError(502, `apex-gateway did not accept the cockpit credential: ${result.message}`);
    }
    throw badRequest(result.message);
  });

  // GET /gateway/oauth/:gatewayId/authorize — start the OAuth consent flow for
  // an authorization_code upstream, as the signed-in operator. The cockpit is
  // the gateway's only operator surface (its admin UI is gone), so consent has
  // to ride the cockpit session: mint the operator's principal JWT, ask the
  // gateway for the provider's authorization URL, and send the browser there.
  // Full-page navigation, not fetch — the provider's consent page must render.
  router.get("/gateway/oauth/:gatewayId/authorize", async (req, res) => {
    assertBoardOrAgent(req);
    const operatorToken = (await opts.mintOperatorToken?.(req)) ?? null;
    if (!operatorToken) {
      // No env-token fallback here on purpose: the provider token that comes
      // back is stored keyed to the initiating identity's email, and later MCP
      // calls look it up by the calling user's email — consent minted under a
      // service identity would never be found for any human operator.
      throw badRequest("OAuth consent requires a signed-in operator session");
    }
    const result = await new GatewayClient(operatorToken).oauthAuthorizeLocation(req.params.gatewayId);
    if (!result.ok) {
      throw new HttpError(result.status >= 500 ? 502 : result.status, `apex-gateway refused to start the OAuth flow: ${result.message}`);
    }
    res.redirect(result.url);
  });

  // POST /gateway/oauth/:gatewayId/fetch-tools — sync the upstream's tools
  // after consent lands. Same operator-only rule as authorize above.
  router.post("/gateway/oauth/:gatewayId/fetch-tools", async (req, res) => {
    assertBoardOrAgent(req);
    const operatorToken = (await opts.mintOperatorToken?.(req)) ?? null;
    if (!operatorToken) {
      throw badRequest("OAuth tool sync requires a signed-in operator session");
    }
    const result = await new GatewayClient(operatorToken).oauthFetchTools(req.params.gatewayId);
    if (!result.ok) {
      throw new HttpError(result.status >= 500 ? 502 : result.status, `tool sync failed: ${result.message}`);
    }
    res.json({ message: result.message });
  });

  // GET /gateway/agents — the A2A agent registry, a distinct governance object
  // from the tool/server registry above.
  router.get("/gateway/agents", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      const client = await clientFor(req);
      res.json(await client.listAgents());
    } catch (e) {
      console.error("[gateway] agents", e);
      res.json([]);
    }
  });

  // GET /gateway/audit?limit= — the audit ledger: who called what tool, with
  // what scope, was it allowed. The governance evidence trail, not a metric.
  // Fire-and-forget feeds each NEW entry (dedup'd via seenAuditIds) into
  // apex-eval (ToolSuccessRateEvaluator via EvalIngestClient), so audit
  // outcomes show up in Observe's Evals card too.
  router.get("/gateway/audit", async (req, res) => {
    assertBoardOrAgent(req);
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) || 100 : 100;
    try {
      const client = await clientFor(req);
      const entries = await client.listAudit(limit);
      res.json(entries);
      for (const entry of entries) {
        if (markSeen(entry.id)) continue;
        evalIngestClient
          .evaluateGatewayAudit({
            auditEntryId: entry.id,
            action: entry.action,
            success: entry.success,
            resourceId: entry.resourceId ?? undefined,
          })
          .catch((e) => console.warn("[gateway] audit eval ingest failed", e));
      }
    } catch (e) {
      console.error("[gateway] audit", e);
      res.json([]);
    }
  });

  return router;
}
