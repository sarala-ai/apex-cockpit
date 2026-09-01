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

export function apexGatewayObserveRoutes(client: GatewayClient = new GatewayClient()) {
  const router = Router();
  const evalIngestClient = new EvalIngestClient();

  // GET /gateway/registry — everything callable: upstream gateways, tools,
  // virtual servers. Grouped together since they answer the same question
  // ("what's registered/callable"), distinct from the agent registry below.
  router.get("/gateway/registry", async (req, res) => {
    assertBoardOrAgent(req);
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
    throw badRequest(result.message);
  });

  // GET /gateway/agents — the A2A agent registry, a distinct governance object
  // from the tool/server registry above.
  router.get("/gateway/agents", async (req, res) => {
    assertBoardOrAgent(req);
    try {
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
