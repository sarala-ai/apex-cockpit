/**
 * APEX cloud/account discovery (apex-tower migration — Task 2 §1).
 *
 * Read-only control-plane queries that back the one-time "connect a product to
 * its Google org + GitHub org" flow: check auth status, and load the existing
 * GCP projects/orgs and GitHub orgs/repos the authed accounts can see. Shells
 * `gcloud`/`gh` (deterministic core, already-authed). Nothing here provisions;
 * creation goes through APEX workflows.
 *
 * These are a 1:1 Express re-expression of the Fastify endpoints in
 * `server/src/apex/index.ts` (`GET /setup/*`). The shell-out + classified-error
 * logic is reused unchanged from `server/src/apex/setup/cloud.ts`.
 *
 * Company/product CRUD is NOT duplicated here — the UI Setup flow points at the
 * fork's existing `companiesApi`/`projectsApi` for that. This route only serves
 * discovery (`/setup/*`).
 */

import { Router } from "express";
import { type Db, operatorWorkstationReports } from "@paperclipai/db";
import { submitWorkstationReportSchema } from "@paperclipai/shared";
import {
  listGcpOrgs,
  listGcpProjects,
  listGithubOrgs,
  listGithubRepos,
} from "../apex/setup/cloud.js";
import { readWorkstationReport, resolveOperatorAuth } from "../apex/setup/operator-auth.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertBoardOrAgent } from "./authz.js";
import { unauthorized } from "../errors.js";

export function apexSetupRoutes(db: Db) {
  const router = Router();

  // GET /setup/auth — the operator's gcloud/gh/ADC state. Never throws.
  router.get("/setup/auth", async (req, res) => {
    assertBoardOrAgent(req);
    res.json(await resolveOperatorAuth(db, req.actor?.userId ?? null));
  });

  // The operator's workstation (desktop app, `apex doctor --report`) is the
  // only party that can truthfully answer operator-scoped setup questions on a
  // hosted cockpit. One row per operator, replaced on each report.
  router.put("/setup/workstation-report", validate(submitWorkstationReportSchema), async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) throw unauthorized("Board session has no user identity");
    const reportedAt = new Date();
    await db
      .insert(operatorWorkstationReports)
      .values({ userId, source: req.body.source, report: req.body.report, reportedAt })
      .onConflictDoUpdate({
        target: operatorWorkstationReports.userId,
        set: { source: req.body.source, report: req.body.report, reportedAt },
      });
    res.json({ ok: true, reportedAt: reportedAt.toISOString() });
  });

  router.get("/setup/workstation-report", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId;
    if (!userId) throw unauthorized("Board session has no user identity");
    const row = await readWorkstationReport(db, userId);
    res.json(row ? { report: row.report, reportedAt: row.reportedAt.toISOString() } : { report: null, reportedAt: null });
  });

  // GET /setup/gcp/projects — GCP projects the authed account can see.
  router.get("/setup/gcp/projects", async (req, res) => {
    assertBoardOrAgent(req);
    const r = await listGcpProjects();
    res.json(
      r.ok
        ? { projects: r.value, source: r.source }
        : { projects: [], source: r.source, note: r.message },
    );
  });

  // GET /setup/gcp/orgs — GCP organizations the authed account can see.
  router.get("/setup/gcp/orgs", async (req, res) => {
    assertBoardOrAgent(req);
    const r = await listGcpOrgs();
    res.json(
      r.ok
        ? { orgs: r.value, source: r.source }
        : { orgs: [], source: r.source, note: r.message },
    );
  });

  // GET /setup/github/orgs — GitHub orgs the authed user belongs to.
  router.get("/setup/github/orgs", async (req, res) => {
    assertBoardOrAgent(req);
    const r = await listGithubOrgs();
    res.json(
      r.ok
        ? { orgs: r.value, source: r.source }
        : { orgs: [], source: r.source, note: r.message },
    );
  });

  // GET /setup/github/repos?org=<login> — repos under a GitHub org (or the
  // authed user when org is omitted).
  router.get("/setup/github/repos", async (req, res) => {
    assertBoardOrAgent(req);
    const org = typeof req.query.org === "string" ? req.query.org : "";
    const r = await listGithubRepos(org);
    res.json(
      r.ok
        ? { repos: r.value, source: r.source }
        : { repos: [], source: r.source, note: r.message },
    );
  });

  return router;
}
