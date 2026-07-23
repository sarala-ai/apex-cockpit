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
import { assertBoardOrAgent } from "./authz.js";

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function apexObserveRoutes(db: Db) {
  const router = Router();

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

  // GET /observe/agent-runs — recent embedded-agent runs (heartbeat_runs), the
  // agent-work side of Observe. DB-backed, read-only, failure-isolated: any error
  // returns `{ runs: [], note }` so the card renders guidance, never a 500.
  // `usage` is surfaced from the run's `usageJson` when present; it's null for
  // runs whose adapter didn't report token usage (an upstream adapter gap — the
  // finalization already persists usage when the adapter returns it).
  router.get("/observe/agent-runs", async (req, res) => {
    assertBoardOrAgent(req);
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
