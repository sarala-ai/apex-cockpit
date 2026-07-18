/**
 * APEX Org + cloud-scope routes (apex-tower §1).
 *
 * Persists the Org entity (holding company above `companies`) and GCP/repo
 * scoping at the ORG and COMPANY levels — the org → company → project cascade
 * the resolver reads. Product/project-level binding stays on `projects.env`.
 *
 * Read-only discovery still lives in apex-setup.ts; this route owns the
 * persisted Org/scope model.
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { type Db, orgs, companies, cloudScopeBindings } from "@paperclipai/db";
import { assertBoardOrAgent } from "./authz.js";

type ScopeType = "org" | "company";

function isScopeType(v: string): v is ScopeType {
  return v === "org" || v === "company";
}

export function apexScopingRoutes(db: Db) {
  const router = Router();

  // --- Orgs ------------------------------------------------------------------
  router.get("/orgs", async (req, res) => {
    assertBoardOrAgent(req);
    res.json({ orgs: await db.select().from(orgs) });
  });

  router.post("/orgs", async (req, res) => {
    assertBoardOrAgent(req);
    const { name, googleOrg, githubOrg } = (req.body ?? {}) as {
      name?: string;
      googleOrg?: { id: string; displayName: string } | null;
      githubOrg?: string | null;
    };
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "body requires { name }" });
      return;
    }
    const [org] = await db
      .insert(orgs)
      .values({ name, googleOrg: googleOrg ?? null, githubOrg: githubOrg ?? null })
      .returning();
    res.json({ org });
  });

  router.get("/orgs/:id", async (req, res) => {
    assertBoardOrAgent(req);
    const [org] = await db.select().from(orgs).where(eq(orgs.id, req.params.id)).limit(1);
    if (!org) {
      res.status(404).json({ error: `no org ${req.params.id}` });
      return;
    }
    res.json({ org });
  });

  // Link a company under an org.
  router.post("/orgs/:orgId/companies", async (req, res) => {
    assertBoardOrAgent(req);
    const { companyId } = (req.body ?? {}) as { companyId?: string };
    if (!companyId) {
      res.status(400).json({ error: "body requires { companyId }" });
      return;
    }
    const [org] = await db.select().from(orgs).where(eq(orgs.id, req.params.orgId)).limit(1);
    if (!org) {
      res.status(404).json({ error: `no org ${req.params.orgId}` });
      return;
    }
    const [company] = await db
      .update(companies)
      .set({ orgId: req.params.orgId, updatedAt: new Date() })
      .where(eq(companies.id, companyId))
      .returning();
    if (!company) {
      res.status(404).json({ error: `no company ${companyId}` });
      return;
    }
    res.json({ company: { id: company.id, name: company.name, orgId: company.orgId } });
  });

  // List companies grouped under an org.
  router.get("/orgs/:orgId/companies", async (req, res) => {
    assertBoardOrAgent(req);
    const rows = await db
      .select({ id: companies.id, name: companies.name, orgId: companies.orgId })
      .from(companies)
      .where(eq(companies.orgId, req.params.orgId));
    res.json({ companies: rows });
  });

  // --- Cloud-scope bindings (org / company level) ----------------------------
  router.get("/apex/scope/:scopeType/:scopeId/cloud-binding", async (req, res) => {
    assertBoardOrAgent(req);
    const { scopeType, scopeId } = req.params;
    if (!isScopeType(scopeType)) {
      res.status(400).json({ error: "scopeType must be 'org' or 'company'" });
      return;
    }
    const [row] = await db
      .select()
      .from(cloudScopeBindings)
      .where(and(eq(cloudScopeBindings.scopeType, scopeType), eq(cloudScopeBindings.scopeId, scopeId)))
      .limit(1);
    res.json({
      scopeType,
      scopeId,
      gcpProjects: row?.gcpProjects ?? [],
      githubRepos: row?.githubRepos ?? [],
    });
  });

  router.put("/apex/scope/:scopeType/:scopeId/cloud-binding", async (req, res) => {
    assertBoardOrAgent(req);
    const { scopeType, scopeId } = req.params;
    if (!isScopeType(scopeType)) {
      res.status(400).json({ error: "scopeType must be 'org' or 'company'" });
      return;
    }
    const body = (req.body ?? {}) as { gcpProjects?: unknown; githubRepos?: unknown };
    const asStrArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    const gcpProjects = asStrArr(body.gcpProjects);
    const githubRepos = asStrArr(body.githubRepos);
    const [row] = await db
      .insert(cloudScopeBindings)
      .values({ scopeType, scopeId, gcpProjects, githubRepos })
      .onConflictDoUpdate({
        target: [cloudScopeBindings.scopeType, cloudScopeBindings.scopeId],
        set: { gcpProjects, githubRepos, updatedAt: new Date() },
      })
      .returning();
    res.json({ scopeType, scopeId, gcpProjects: row.gcpProjects, githubRepos: row.githubRepos });
  });

  return router;
}
