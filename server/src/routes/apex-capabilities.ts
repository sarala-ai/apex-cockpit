/**
 * Capability sync surface (spec: capability sync + PATH-canonical
 * resolution, Session B / T4). Two routes, both auth-guarded the same way
 * as the sibling manual-refresh routes (`assertBoardOrAgent`, matching
 * `POST /observe/attribution/refresh` and `POST /apex/github-ingest`):
 *
 *   GET  /apex/capabilities/sync — read-only. Returns the LAST summary the
 *     periodic job (or a prior manual POST) produced, held in memory by
 *     `capability-sync-job.ts`. Never shells the CLI — keeps the page load
 *     path cheap. `{ranAt: null, summary: null}` before the first run since
 *     boot (honest empty state, not an error).
 *   POST /apex/capabilities/sync — runs `apex capabilities sync` once,
 *     synchronously, updates the in-memory snapshot, and returns it. Same
 *     job the scheduler runs every `APEX_CAPABILITY_SYNC_HOURS`; this is the
 *     on-demand refresh entry point (the Workflows page's refresh button).
 *
 * Both always 200 — a degraded/unreleased CLI comes back as a classified
 * `CapabilitySyncError` body inside `summary`, never an HTTP error, same
 * convention as `apex-workflows.ts`.
 */
import { Router } from "express";
import { assertBoardOrAgent } from "./authz.js";
import { getLastCapabilitySync, runCapabilitySync } from "../apex/capability-sync-job.js";

// No `db` parameter: the job is company-agnostic (syncs every configured
// source regardless of which company is active in the UI — see
// capability-sync-job.ts's header), so this route has nothing to look up.
export function apexCapabilitiesRoutes() {
  const router = Router();

  router.get("/apex/capabilities/sync", (req, res) => {
    assertBoardOrAgent(req);
    const snapshot = getLastCapabilitySync();
    res.json(snapshot ?? { ranAt: null, summary: null });
  });

  router.post("/apex/capabilities/sync", async (req, res) => {
    assertBoardOrAgent(req);
    try {
      await runCapabilitySync();
      const snapshot = getLastCapabilitySync();
      // runCapabilitySync always sets the snapshot before returning, so this
      // is defensive, not a real branch — see capability-sync-job.ts.
      res.json(snapshot ?? { ranAt: null, summary: null });
    } catch (e) {
      console.error("[apex] capabilities/sync", e);
      res.status(500).json({ error: e instanceof Error ? e.message : "capability sync failed" });
    }
  });

  return router;
}
