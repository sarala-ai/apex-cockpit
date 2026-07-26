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

export function apexGatewayObserveRoutes() {
  const router = Router();
  const client = new GatewayClient();
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
