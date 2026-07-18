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
import { type Db, orgs, companies, cloudScopeBindings, orgMemberships } from "@paperclipai/db";
import { assertBoardOrAgent } from "./authz.js";

type ScopeType = "org" | "company";

function isScopeType(v: string): v is ScopeType {
  return v === "org" || v === "company";
}

/** Membership role vocabulary (owner/admin/member today; reviewer/observer are
 *  reserved for the future no-cloud read-only tiers — see apex-tower onboarding). */
type OrgRole = "owner" | "admin" | "member";

/** The signed-in principal's user id, or null when unauthenticated. In
 *  local_trusted mode this is the synthetic `"local-board"` id (no FK enforced). */
function actorUserId(req: import("express").Request): string | null {
  return req.actor?.userId ?? null;
}

/** True when `userId` is an owner/admin of `orgId` (or a trusted instance admin). */
async function isOrgOwnerOrAdmin(db: Db, orgId: string, req: import("express").Request): Promise<boolean> {
  if (req.actor?.isInstanceAdmin) return true;
  const userId = actorUserId(req);
  if (!userId) return false;
  const [row] = await db
    .select({ role: orgMemberships.role, status: orgMemberships.status })
    .from(orgMemberships)
    .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
    .limit(1);
  return row?.status === "active" && (row.role === "owner" || row.role === "admin");
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

    // Bootstrap = owner. Whoever creates the org (the first user on an otherwise
    // empty instance) is its owner (active). Every later user is mapped as a
    // pending member and an owner/admin approves them (POST .../members below).
    // This is the org-level analogue of the instance `first-admin-claim`.
    const userId = actorUserId(req);
    let membership: typeof orgMemberships.$inferSelect | null = null;
    if (userId) {
      const [row] = await db
        .insert(orgMemberships)
        .values({ orgId: org.id, userId, role: "owner", status: "active" })
        .onConflictDoNothing({ target: [orgMemberships.orgId, orgMemberships.userId] })
        .returning();
      membership = row ?? null;
    }
    res.json({ org, membership });
  });

  // --- Org memberships (identity → org, owner-approved) ----------------------

  // List an org's members (owner/admin/member roster).
  router.get("/orgs/:orgId/members", async (req, res) => {
    assertBoardOrAgent(req);
    const rows = await db
      .select()
      .from(orgMemberships)
      .where(eq(orgMemberships.orgId, req.params.orgId));
    res.json({ members: rows });
  });

  // The current user's own membership in an org (null if none) — drives the
  // wizard's state branch (bootstrap-as-owner vs member vs awaiting-approval).
  router.get("/orgs/:orgId/membership", async (req, res) => {
    assertBoardOrAgent(req);
    const userId = actorUserId(req);
    if (!userId) {
      res.json({ membership: null });
      return;
    }
    const [row] = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, req.params.orgId), eq(orgMemberships.userId, userId)))
      .limit(1);
    res.json({ membership: row ?? null });
  });

  // Request access to an org: the current user (or, for an admin, a named user)
  // is mapped as a pending member. Idempotent on (orgId, userId).
  router.post("/orgs/:orgId/members", async (req, res) => {
    assertBoardOrAgent(req);
    const { orgId } = req.params;
    const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (!org) {
      res.status(404).json({ error: `no org ${orgId}` });
      return;
    }
    const body = (req.body ?? {}) as { userId?: string; role?: OrgRole; status?: "active" | "pending" };
    const selfId = actorUserId(req);
    // Self-service request → self, pending. An owner/admin may name a user and
    // set role/status directly.
    const targetUserId = body.userId ?? selfId;
    if (!targetUserId) {
      res.status(400).json({ error: "no actor userId; body requires { userId }" });
      return;
    }
    const actingAsAdmin = await isOrgOwnerOrAdmin(db, orgId, req);
    const role: OrgRole = actingAsAdmin && body.role ? body.role : "member";
    const status: "active" | "pending" =
      actingAsAdmin && body.status ? body.status : "pending";
    if (!actingAsAdmin && targetUserId !== selfId) {
      res.status(403).json({ error: "only an org owner/admin can map another user" });
      return;
    }
    const [row] = await db
      .insert(orgMemberships)
      .values({ orgId, userId: targetUserId, role, status })
      .onConflictDoNothing({ target: [orgMemberships.orgId, orgMemberships.userId] })
      .returning();
    if (row) {
      res.json({ membership: row });
      return;
    }
    // Already mapped — return the existing row (idempotent).
    const [existing] = await db
      .select()
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, targetUserId)))
      .limit(1);
    res.json({ membership: existing ?? null });
  });

  // Approve (activate) a pending member. Owner/admin only.
  // NOTE (placeholder): the fork's richer Approvals machinery
  // (server/src/routes/access.ts) is the eventual home for this — this is the
  // minimal owner-gated activation to make onboarding functional end-to-end.
  router.post("/orgs/:orgId/members/:userId/approve", async (req, res) => {
    assertBoardOrAgent(req);
    const { orgId, userId } = req.params;
    if (!(await isOrgOwnerOrAdmin(db, orgId, req))) {
      res.status(403).json({ error: "only an org owner/admin can approve members" });
      return;
    }
    const [row] = await db
      .update(orgMemberships)
      .set({ status: "active", updatedAt: new Date() })
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .returning();
    if (!row) {
      res.status(404).json({ error: `no membership for user ${userId} in org ${orgId}` });
      return;
    }
    res.json({ membership: row });
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
