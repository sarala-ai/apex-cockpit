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
import { z } from "zod";
import { desc, eq, inArray } from "drizzle-orm";
import { type Db, heartbeatRuns, agents, issues } from "@paperclipai/db";
import { getApexRuns, getCiRuns } from "../apex/observe.js";
import { HeartbeatObserveStore } from "../observe/heartbeat-store.js";
import { CloudTraceObserveStore } from "../observe/cloud-trace-store.js";
import { CompositeObserveStore } from "../observe/composite-store.js";
import { ApexEvalTraceClient } from "../observe/apex-eval-client.js";
import { GcpInventoryStore } from "../observe/gcp-inventory-store.js";
import { GatewayClient } from "../gateway/gateway-client.js";
import { EvalIngestClient } from "../observe/eval-ingest-client.js";
import { observeInputs } from "../observe/tools.js";
import { assertBoardOrAgent, getActorInfo } from "./authz.js";
import { importMapperReport, upsertManualAttribution } from "../observe/resource-attribution-store.js";
import { runAttributionRefresh } from "../observe/attribution-refresh.js";

const attributionImportSchema = z.object({
  companyId: z.string(),
  projectId: z.string(),
  report: z.record(z.string(), z.unknown()),
});

const attributionManualSchema = z.object({
  companyId: z.string(),
  projectId: z.string(),
  resourceUri: z.string(),
  assetType: z.string(),
  workflow: z.string().nullable().optional(),
  repo: z.string().nullable().optional(),
  env: z.string().nullable().optional(),
});

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
  const inventoryStore = new GcpInventoryStore(db);
  const gatewayClient = new GatewayClient();
  const evalIngestClient = new EvalIngestClient();

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

  // GET /observe/gcp-inventory?companyId= — full project resource inventory
  // (all asset types via Cloud Asset Inventory), one entry per bound GCP
  // project. Distinct from /observe/fleet (running product agents only) — this
  // is the raw "what's actually deployed" view Cortex-style catalogs cover,
  // built on APEX's own gcp_inventory resource server. Failure-isolated per
  // project (a project error surfaces on its own entry, never a 500).
  router.get("/observe/gcp-inventory", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    try {
      res.json(await inventoryStore.listResources(companyId));
    } catch (e) {
      console.error("[observe] gcp-inventory", e);
      res.json([]);
    }
  });

  // GET /observe/gcp-services?companyId= — grouped service inventory (Cloud
  // Run, enabled APIs, secrets, buckets) per bound GCP project.
  router.get("/observe/gcp-services", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    try {
      res.json(await inventoryStore.listServices(companyId));
    } catch (e) {
      console.error("[observe] gcp-services", e);
      res.json([]);
    }
  });

  // POST /observe/attribution/import — bulk-loads an apex-core `resource-mapper`
  // report's `exact` section as `auto_mapped` rows (spec:
  // resource-attribution-mapping). Idempotent on (projectId, resourceUri); never
  // imports proposals/drift (those need human review first, not a bulk write),
  // and never overwrites a row a human has since promoted to `manual`.
  router.post("/observe/attribution/import", async (req, res) => {
    assertBoardOrAgent(req);
    const body = attributionImportSchema.parse(req.body);
    try {
      const result = await importMapperReport(db, body.companyId, body.projectId, body.report);
      res.json(result);
    } catch (e) {
      console.error("[observe] attribution/import", e);
      res.status(500).json({ error: e instanceof Error ? e.message : "import failed" });
    }
  });

  // POST /observe/attribution/manual — a human's conflict-resolution decision.
  // Always upserts as `source: "manual"`, which always wins the precedence
  // merge in gcp-inventory-store regardless of what auto-mapping or cloud
  // label say about the same resource.
  router.post("/observe/attribution/manual", async (req, res) => {
    assertBoardOrAgent(req);
    const body = attributionManualSchema.parse(req.body);
    const actor = getActorInfo(req);
    try {
      const row = await upsertManualAttribution(db, {
        ...body,
        decidedBy: actor.actorId,
      });
      res.json(row);
    } catch (e) {
      console.error("[observe] attribution/manual", e);
      res.status(500).json({ error: e instanceof Error ? e.message : "manual attribution failed" });
    }
  });

  // POST /observe/attribution/refresh — runs the recurring attribution-refresh
  // job (`observe/attribution-refresh.ts`) once, synchronously, and returns its
  // per-company/repo/project summary. This is the SAME job the scheduler runs
  // every `APEX_ATTRIBUTION_REFRESH_HOURS`; the route exists so tests/demos
  // have a deterministic on-demand entry point rather than waiting on the
  // clock. Failure-isolated internally (see attribution-refresh.ts) — never
  // 500s for a single company/repo/project's failure, only for something
  // breaking the job itself.
  router.post("/observe/attribution/refresh", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      const summary = await runAttributionRefresh(db);
      res.json(summary);
    } catch (e) {
      console.error("[observe] attribution/refresh", e);
      res.status(500).json({ error: e instanceof Error ? e.message : "attribution refresh failed" });
    }
  });

  // GET /observe/attribution/conflicts?companyId= — resources where the live
  // cloud label and a db auto_mapped row disagree on workflow/repo/env. The
  // cloud label stays effective either way (precedence); this just surfaces
  // the disagreement so a human can "keep mapping" (POST .../manual) if the
  // label is wrong.
  router.get("/observe/attribution/conflicts", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (!companyId) {
      res.status(400).json({ error: "companyId is required" });
      return;
    }
    try {
      res.json(await inventoryStore.attributionConflicts(companyId));
    } catch (e) {
      console.error("[observe] attribution/conflicts", e);
      res.json([]);
    }
  });

  // GET /observe/gcp-resource-health?companyId=&projectId=&resourceType=&resourceName=&resourceId=
  // — on-demand health check for one inventory resource (bucket, secret,
  // firestore, artifact_registry, cloud_run — see gcp_inventory.py's supported
  // types). Returns null (not 404) on failure so the UI can show "unavailable".
  // Fire-and-forget feeds the result into apex-eval (RunCompletedEvaluator via
  // EvalIngestClient) so it shows up in Observe's Evals card — never awaited,
  // so a slow/down apex-eval can't add latency to this response.
  router.get("/observe/gcp-resource-health", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    const resourceType = typeof req.query.resourceType === "string" ? req.query.resourceType : "";
    const resourceName = typeof req.query.resourceName === "string" ? req.query.resourceName : "";
    const resourceId = typeof req.query.resourceId === "string" ? req.query.resourceId : undefined;
    if (!projectId || !resourceType || !resourceName) {
      res.status(400).json({ error: "projectId, resourceType, and resourceName are required" });
      return;
    }
    const health = await inventoryStore.resourceHealth(companyId, projectId, resourceType, resourceName);
    res.json(health);
    if (health) {
      evalIngestClient
        .evaluateResourceHealth({
          projectId,
          resourceType,
          resourceName,
          resourceId,
          companyId,
          healthy: health.status === "healthy",
        })
        .catch((e) => console.warn("[observe] resource-health eval ingest failed", e));
    }
  });

  // GET /observe/gateway-metrics — apex-gateway's tool/server/agent invocation
  // metrics (throughput, failure rate, avg response time). Operational health,
  // not governance — the registry/audit-ledger side of the gateway lives under
  // /gateway/* (apex-gateway-observe.ts) instead.
  router.get("/observe/gateway-metrics", async (_req, res) => {
    assertBoardOrAgent(_req);
    try {
      res.json(await gatewayClient.metrics());
    } catch (e) {
      console.error("[observe] gateway-metrics", e);
      res.json({ reachable: false, tools: null, servers: null, a2aAgents: null, error: "failed to load metrics" });
    }
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
