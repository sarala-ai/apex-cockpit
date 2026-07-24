/**
 * APEX / CI run observability (apex-tower migration — Task 2 §3b).
 *
 * Ops-side of Observe: the status of APEX workflow instances and GitHub Actions
 * runs. These have NO fork analog (the fork's Costs surface is LLM token/spend,
 * not infra-run status), so they're a small new route rather than a rewire —
 * ported near-verbatim from the staged Fastify endpoints in `server/src/apex/
 * index.ts` (`GET /observe/apex-runs`, `/observe/ci-runs`).
 *
 * The token/cost half of Observe (§3a) is intentionally NOT here — that folds
 * into the fork's `cost_events` table + `Costs.tsx` once live OTel/SigNoz
 * ingestion writes per-call rows; a parallel `/observe/tokens` endpoint would
 * just duplicate the fork's cost surface.
 *
 * Read-only, shells `apex`/`gh` (deterministic core, already-authed). Never
 * provisions.
 */

import { Router } from "express";
import { desc, eq, inArray } from "drizzle-orm";
import { type Db, heartbeatRuns, agents, issues } from "@paperclipai/db";
import { getApexRuns, getCiRuns } from "../apex/observe.js";
import { HeartbeatObserveStore } from "../observe/heartbeat-store.js";
import { CloudTraceObserveStore } from "../observe/cloud-trace-store.js";
import { CompositeObserveStore } from "../observe/composite-store.js";
import { ApexEvalTraceClient } from "../observe/apex-eval-client.js";
import { observeInputs } from "../observe/tools.js";
import { assertBoardOrAgent } from "./authz.js";

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function apexObserveRoutes(db: Db) {
  const router = Router();

  // Contract-shaped observe surface, backed by a composite ObserveStore: the
  // coding-agent plane (heartbeat_runs) ⊕ the product-agent plane (Cloud Run via
  // apex gcp_observability), behind the SAME interface. Thin passthrough routes —
  // logic lives in the stores + observe tools, reusable by the observe MCP server
  // + agents. The product plane is optional: if apex isn't installed it's silently
  // empty and the coding plane still works.
  const cloudStore = new CloudTraceObserveStore(db);
  const evalClient = new ApexEvalTraceClient();
  const store = new CompositeObserveStore(
    [new HeartbeatObserveStore(db), cloudStore],
    [evalClient],
  );

  // GET /observe/gcp-resource?companyId=&service= — the unified product-agent view:
  // a Cloud Run service's live GCP resource health + recent logs (from apex
  // observability), correlated with the app runs its agent emitted (from apex-eval,
  // keyed by agentName == service name). Every source is failure-isolated: apex CLI
  // or apex-eval down → that slice degrades to empty/null, never a 500.
  router.get("/observe/gcp-resource", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    const service = typeof req.query.service === "string" ? req.query.service : "";
    if (!service) {
      res.status(400).json({ error: "service is required" });
      return;
    }
    const [health, logs, runs] = await Promise.all([
      cloudStore.serviceHealth(companyId, service).catch(() => null),
      cloudStore.serviceLogs(companyId, service).catch(() => []),
      evalClient.getRuns(companyId, service).catch(() => []),
    ]);
    res.json({ health, logs, runs });
  });

  router.get("/observe/fleet", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      res.json(await store.fleet(observeInputs.fleet.parse(req.query)));
    } catch (e) {
      console.error("[observe] fleet", e);
      res.json([]);
    }
  });

  router.get("/observe/runs", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      res.json(await store.runs(observeInputs.runs.parse(req.query)));
    } catch (e) {
      console.error("[observe] runs", e);
      res.json([]);
    }
  });

  router.get("/observe/health", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      res.json(await store.health(observeInputs.health.parse(req.query)));
    } catch (e) {
      console.error("[observe] health", e);
      res.json(null);
    }
  });

  router.get("/observe/run-detail/:runId", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      const detail = await store.runDetail({ runId: req.params.runId });
      if (!detail) {
        res.status(404).json({ error: "run not found" });
        return;
      }
      res.json(detail);
    } catch (e) {
      console.error("[observe] run-detail", e);
      res.status(500).json({ error: "failed to read run detail" });
    }
  });

  router.get("/observe/evals", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      res.json(await store.evals(observeInputs.evals.parse(req.query)));
    } catch (e) {
      console.error("[observe] evals", e);
      res.json([]);
    }
  });

  router.get("/observe/regressions", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      res.json(await store.regressions(observeInputs.regressions.parse(req.query)));
    } catch (e) {
      console.error("[observe] regressions", e);
      res.json([]);
    }
  });

  // GET /observe/apex-runs — recent APEX workflow instances (apex CLI, else
  // ~/.apex/instances.json fallback). Never throws.
  router.get("/observe/apex-runs", async (req, res) => {
    assertBoardOrAgent(req);
    const r = await getApexRuns();
    res.json(
      r.ok
        ? { runs: r.value, source: r.source }
        : { runs: [], source: r.source, note: r.message },
    );
  });

  // GET /observe/ci-runs?repo=owner/name — recent GitHub Actions runs for a repo.
  // Returns a note (not an error status) when repo is omitted or gh is unauthed,
  // so the card can render guidance instead of failing.
  router.get("/observe/ci-runs", async (req, res) => {
    assertBoardOrAgent(req);
    const repo = typeof req.query.repo === "string" ? req.query.repo : "";
    const r = await getCiRuns(repo);
    res.json(
      r.ok
        ? { runs: r.value, source: r.source }
        : { runs: [], source: r.source, note: r.message },
    );
  });

  // GET /observe/agent-runs?companyId=… — recent embedded-agent runs
  // (heartbeat_runs), the agent-work side of Observe. This is REAL observability
  // (agent executions), not resource visibility — so it is scoped per company:
  // pass `companyId` to see one company's fleet (uses the
  // heartbeat_runs_company_agent_started index). Omitting it returns the global
  // view (back-compat). DB-backed, read-only, failure-isolated: any error returns
  // `{ runs: [], note }` so the card renders guidance, never a 500. `usage` is
  // surfaced from the run's `usageJson` when present; it's null for runs whose
  // adapter didn't report token usage (an upstream adapter gap — the finalization
  // already persists usage when the adapter returns it).
  router.get("/observe/agent-runs", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : null;
    try {
      const rows = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          exitCode: heartbeatRuns.exitCode,
          agentName: agents.name,
          usageJson: heartbeatRuns.usageJson,
          resultJson: heartbeatRuns.resultJson,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(companyId ? eq(heartbeatRuns.companyId, companyId) : undefined)
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(25);

      // Resolve issue titles for the runs that carry an issueId (in the run's
      // context snapshot) — one batched lookup rather than a jsonb join.
      const issueIds = [
        ...new Set(
          rows
            .map((r) => (r.contextSnapshot as Record<string, unknown> | null)?.issueId)
            .filter((v): v is string => typeof v === "string"),
        ),
      ];
      const issueTitles = new Map<string, string>();
      if (issueIds.length > 0) {
        const irows = await db
          .select({ id: issues.id, title: issues.title })
          .from(issues)
          .where(inArray(issues.id, issueIds));
        for (const i of irows) issueTitles.set(i.id, i.title);
      }

      const runs = rows.map((r) => {
        const ctx = (r.contextSnapshot ?? {}) as Record<string, unknown>;
        const issueId = typeof ctx.issueId === "string" ? ctx.issueId : null;
        const usage = (r.usageJson ?? null) as Record<string, unknown> | null;
        const result = (r.resultJson ?? {}) as Record<string, unknown>;
        const start = r.startedAt ? new Date(r.startedAt).getTime() : null;
        const end = r.finishedAt ? new Date(r.finishedAt).getTime() : null;
        return {
          id: r.id,
          agentName: r.agentName,
          issueId,
          issueTitle: issueId ? (issueTitles.get(issueId) ?? null) : null,
          status: r.status,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          durationMs: start != null && end != null ? Math.max(0, end - start) : null,
          exitCode: r.exitCode,
          stopReason: typeof result.stopReason === "string" ? result.stopReason : null,
          usage: usage
            ? {
                inputTokens: numOrNull(usage.inputTokens),
                outputTokens: numOrNull(usage.outputTokens),
                cachedInputTokens: numOrNull(usage.cachedInputTokens),
                costUsd: numOrNull(usage.costUsd),
                model: typeof usage.model === "string" ? usage.model : null,
              }
            : null,
        };
      });
      res.json({ runs, source: "db" });
    } catch (e) {
      res.json({
        runs: [],
        source: "unavailable",
        note: e instanceof Error ? e.message : "Failed to read agent runs",
      });
    }
  });

  return router;
}
