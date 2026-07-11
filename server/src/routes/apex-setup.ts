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
import {
  checkAuth,
  listGcpOrgs,
  listGcpProjects,
  listGithubOrgs,
  listGithubRepos,
} from "../apex/setup/cloud.js";
import { assertBoardOrAgent } from "./authz.js";

export function apexSetupRoutes() {
  const router = Router();

  // GET /setup/auth — gcloud/gh auth status. Never throws.
  router.get("/setup/auth", async (req, res) => {
    assertBoardOrAgent(req);
    res.json(await checkAuth());
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
