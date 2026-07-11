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
import { getApexRuns, getCiRuns } from "../apex/observe.js";
import { assertBoardOrAgent } from "./authz.js";

export function apexObserveRoutes() {
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

  return router;
}
