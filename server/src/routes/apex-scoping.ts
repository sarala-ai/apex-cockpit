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
import { accessService, companyService } from "../services/index.js";
import {
  authorizeScope,
  isGovernancePosture,
  type GovernancePosture,
  type ScopeAction,
} from "../apex/scope-policy.js";

type ScopeType = "org" | "company";

function isScopeType(v: string): v is ScopeType {
  return v === "org" || v === "company";
}

/**
 * Resolve the posture × role context for a scope, then run the single policy seam
 * (scope-policy.ts). ALL scope-binding + posture read/write decisions go through
 * here — do not add inline posture/role checks elsewhere. `orgId` is resolved from
 * the scope: org scope → the scope id itself; company scope → the company's org.
 */
async function decideScope(
  db: Db,
  req: import("express").Request,
  action: ScopeAction,
  scope?: { type: ScopeType; id?: string },
): Promise<ReturnType<typeof authorizeScope>> {
  let orgId = scope?.type === "org" ? scope.id : undefined;
  if (scope?.type === "company" && scope.id) {
    const [c] = await db
      .select({ orgId: companies.orgId })
      .from(companies)
      .where(eq(companies.id, scope.id))
      .limit(1);
    orgId = c?.orgId ?? undefined;
  }

  let posture: GovernancePosture = "individual";
  if (orgId) {
    const [org] = await db
      .select({ posture: orgs.governancePosture })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    if (org && isGovernancePosture(org.posture)) posture = org.posture;
  }

  const userId = actorUserId(req);
  let role: string | null = null;
  if (orgId && userId) {
    const [m] = await db
      .select({ role: orgMemberships.role, status: orgMemberships.status })
      .from(orgMemberships)
      .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
      .limit(1);
    role = m?.status === "active" ? m.role : null;
  }

  // Match the fork's authz convention: a local_implicit board actor is treated as
  // instance admin (see authz.ts assertInstanceAdmin).
  const isInstanceAdmin = Boolean(req.actor?.isInstanceAdmin) || req.actor?.source === "local_implicit";

  return authorizeScope({ posture, role, isInstanceAdmin, action, scope });
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
  const companies_svc = companyService(db);
  const access = accessService(db);

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

  // Update an org's GitHub-org mapping and/or governance posture after creation.
  // Gated by the single scope-policy seam (posture.write): all-allow under
  // `individual` (solo owner edits freely), owner/admin-gated under team/enterprise.
  // The githubOrg edit path exists because an org created before that mapping (or
  // left blank) otherwise strands org/company repo discovery on personal repos.
  router.patch("/orgs/:id", async (req, res) => {
    assertBoardOrAgent(req);
    const { id } = req.params;
    const [org] = await db.select().from(orgs).where(eq(orgs.id, id)).limit(1);
    if (!org) {
      res.status(404).json({ error: `no org ${id}` });
      return;
    }
    const decision = await decideScope(db, req, "posture.write", { type: "org", id });
    if (!decision.allow) {
      res.status(403).json({ error: decision.reason });
      return;
    }
    const body = (req.body ?? {}) as { githubOrg?: string | null; governancePosture?: unknown };
    const hasGithubOrg = "githubOrg" in body;
    const hasPosture = "governancePosture" in body;
    if (!hasGithubOrg && !hasPosture) {
      res.status(400).json({ error: "body requires { githubOrg } and/or { governancePosture }" });
      return;
    }
    const update: Partial<typeof orgs.$inferInsert> = {};
    if (hasGithubOrg) {
      update.githubOrg =
        typeof body.githubOrg === "string" && body.githubOrg.trim() ? body.githubOrg.trim() : null;
    }
    if (hasPosture) {
      if (!isGovernancePosture(body.governancePosture)) {
        res.status(400).json({ error: "governancePosture must be individual|team|enterprise" });
        return;
      }
      update.governancePosture = body.governancePosture;
    }
    const [updated] = await db.update(orgs).set(update).where(eq(orgs.id, id)).returning();
    res.json({ org: updated });
  });

  // NOTE: there is no DELETE /orgs/:id route yet (design-review B2, apex-tower).
  // When one is built, it must clean up:
  //   - `cloud_scope_bindings` rows with `scopeType: "org"` for this org — that
  //     table is a generic scopeType/scopeId binding with NO FK to `orgs`
  //     (mirrors the existing `scopeType: "company"` cleanup already done in
  //     companyService.remove(), see server/src/services/companies.ts), so it
  //     will silently orphan unless explicitly deleted here.
  //   - Nothing else needs manual cleanup: `org_memberships` rows cascade-delete
  //     via their DB-level FK (ON DELETE CASCADE, migration 0149), and
  //     `companies.org_id` is automatically nulled via its DB-level FK
  //     (ON DELETE SET NULL, migration 0149) — companies survive their org's
  //     deletion by design (apex-tower §1: "a company can outlive its org
  //     association").

  // Link a company under an org.
  // Create a NEW company under the org ({ name }) OR associate an existing one
  // ({ companyId }). The setup wizard's "Create companies" step uses { name } so
  // company creation is first-class in the flow — no /onboarding detour, and
  // (crucially) NO Reflection Coach seed (seedBundledAgents:false).
  router.post("/orgs/:orgId/companies", async (req, res) => {
    assertBoardOrAgent(req);
    const orgId = req.params.orgId;
    const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId)).limit(1);
    if (!org) {
      res.status(404).json({ error: `no org ${orgId}` });
      return;
    }
    const body = (req.body ?? {}) as { companyId?: string; name?: string };

    // CREATE + associate.
    if (typeof body.name === "string" && body.name.trim().length > 0) {
      const decision = await decideScope(db, req, "company.create", { type: "org", id: orgId });
      if (!decision.allow) {
        res.status(403).json({ error: decision.reason });
        return;
      }
      const ownerPrincipalId = req.actor?.userId ?? "local-board";
      const created = await companies_svc.create(
        { name: body.name.trim(), orgId, defaultResponsibleUserId: ownerPrincipalId },
        { seedBundledAgents: false },
      );
      await access.ensureMembership(created.id, "user", ownerPrincipalId, "owner", "active");
      await access.ensureRoleDefaultGrants(created.id, ownerPrincipalId, "owner", req.actor?.userId ?? null);
      res.status(201).json({ company: { id: created.id, name: created.name, orgId } });
      return;
    }

    // ASSOCIATE an existing company.
    const { companyId } = body;
    if (!companyId) {
      res.status(400).json({ error: "body requires { name } (create) or { companyId } (associate)" });
      return;
    }
    const [company] = await db
      .update(companies)
      .set({ orgId, updatedAt: new Date() })
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
    // Display is governed by the SAME seam as writes: the policy's scopeFilter is
    // applied to what's returned (identity/no-op under individual posture; a real
    // filter under enterprise once the authz pass lands).
    const decision = await decideScope(db, req, "binding.read", { type: scopeType, id: scopeId });
    if (!decision.allow) {
      res.status(403).json({ error: decision.reason });
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
      gcpProjects: decision.scopeFilter(row?.gcpProjects ?? []),
      githubRepos: decision.scopeFilter(row?.githubRepos ?? []),
    });
  });

  router.put("/apex/scope/:scopeType/:scopeId/cloud-binding", async (req, res) => {
    assertBoardOrAgent(req);
    const { scopeType, scopeId } = req.params;
    if (!isScopeType(scopeType)) {
      res.status(400).json({ error: "scopeType must be 'org' or 'company'" });
      return;
    }
    // Writes route through the single policy seam (all-allow under individual;
    // owner/admin-gated under team/enterprise).
    const decision = await decideScope(db, req, "binding.write", { type: scopeType, id: scopeId });
    if (!decision.allow) {
      res.status(403).json({ error: decision.reason });
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
