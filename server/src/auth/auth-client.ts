import type { Request } from "express";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
  teamMemberships,
  teams,
} from "@paperclipai/db";
import type { BetterAuthSessionResult } from "./better-auth.js";
import { logger } from "../middleware/logger.js";

export interface HumanMembership {
  companyId: string;
  membershipRole: string | null;
  status: string;
}

export interface HumanIdentity {
  userId: string;
  userName: string | null;
  userEmail: string | null;
  companyIds: string[];
  memberships: HumanMembership[];
  isInstanceAdmin: boolean;
}

/**
 * Resolves a human (session-backed) identity from a request into the tenancy
 * bundle the actor middleware needs. This is the swappable seam: the cockpit
 * uses the in-process implementation; the gateway will use an HTTP client that
 * calls the cockpit's resolve endpoint over a trusted hop.
 */
export interface AuthClient {
  resolveHuman(req: Request): Promise<HumanIdentity | null>;
}

export class InProcessAuthClient implements AuthClient {
  constructor(
    private readonly db: Db,
    private readonly resolveSession: (req: Request) => Promise<BetterAuthSessionResult | null>,
  ) {}

  async resolveHuman(req: Request): Promise<HumanIdentity | null> {
    let session: BetterAuthSessionResult | null = null;
    try {
      session = await this.resolveSession(req);
    } catch (err) {
      logger.warn(
        { err, method: req.method, url: req.originalUrl },
        "Failed to resolve auth session from request headers",
      );
    }
    if (!session?.user?.id) return null;

    const userId = session.user.id;
    const [roleRow, memberships] = await Promise.all([
      this.db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
      this.db
        .select({
          companyId: companyMemberships.companyId,
          membershipRole: companyMemberships.membershipRole,
          status: companyMemberships.status,
        })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, userId),
            eq(companyMemberships.status, "active"),
          ),
        ),
    ]);

    return {
      userId,
      userName: session.user.name ?? null,
      userEmail: session.user.email ?? null,
      companyIds: memberships.map((row) => row.companyId),
      memberships,
      isInstanceAdmin: Boolean(roleRow),
    };
  }
}

// The APEX principal, materialised as the claims of the cockpit-issued JWT
// (better-auth `jwt` plugin). The gateway verifies these tokens against the
// cockpit JWKS and enforces from these claims — so this shape IS the contract
// between cockpit (the human-identity authority) and the gateway (the PEP).
export interface PrincipalCompanyScope {
  id: string;
  orgId: string | null;
  role: string | null;
  teams: { id: string; role: string }[];
  scopes: string[];
}

export interface PrincipalClaims {
  email: string | null;
  // OIDC-standard verified-email flag. External verifiers (the apex-gateway's
  // API-bearer path) require `email_verified` to provision the identity — an
  // IdP-authenticated (Google Workspace) user's email is verified by that IdP.
  email_verified: boolean;
  name: string | null;
  // The IdP that authenticated this user (null for local email+password).
  idp: { issuer: string; sub: string } | null;
  instanceAdmin: boolean;
  // Set only when the user belongs to exactly one company (the unambiguous
  // scope); otherwise null and the consumer selects from `companies`.
  companyId: string | null;
  companies: PrincipalCompanyScope[];
  // Flat team-id list across all companies — matches the gateway's existing
  // `teams`-claim scoping expectation.
  teams: string[];
}

// Builds the principal claims for a user by reading the tenancy spine
// (memberships, teams, permission grants). Async and DB-backed; called from
// the jwt plugin's definePayload on token issuance.
export async function buildPrincipalClaims(db: Db, userId: string): Promise<PrincipalClaims> {
  const [userRow, adminRow, memberships, teamRows, grantRows] = await Promise.all([
    db
      .select({
        email: authUsers.email,
        emailVerified: authUsers.emailVerified,
        name: authUsers.name,
        idpIssuer: authUsers.idpIssuer,
        idpSubject: authUsers.idpSubject,
      })
      .from(authUsers)
      .where(eq(authUsers.id, userId))
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null),
    db
      .select({ companyId: companyMemberships.companyId, membershipRole: companyMemberships.membershipRole })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, userId),
          eq(companyMemberships.status, "active"),
        ),
      ),
    db
      .select({ teamId: teamMemberships.teamId, role: teamMemberships.role, companyId: teams.companyId })
      .from(teamMemberships)
      .innerJoin(teams, eq(teamMemberships.teamId, teams.id))
      .where(eq(teamMemberships.userId, userId)),
    db
      .select({ companyId: principalPermissionGrants.companyId, permissionKey: principalPermissionGrants.permissionKey })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.principalType, "user"),
          eq(principalPermissionGrants.principalId, userId),
        ),
      ),
  ]);

  const companyIds = memberships.map((m) => m.companyId);
  const companyRows = companyIds.length
    ? await db.select({ id: companies.id, orgId: companies.orgId }).from(companies).where(inArray(companies.id, companyIds))
    : [];
  const orgById = new Map(companyRows.map((c) => [c.id, c.orgId]));

  const companiesScope: PrincipalCompanyScope[] = memberships.map((m) => ({
    id: m.companyId,
    orgId: orgById.get(m.companyId) ?? null,
    role: m.membershipRole ?? null,
    teams: teamRows.filter((t) => t.companyId === m.companyId).map((t) => ({ id: t.teamId, role: t.role })),
    scopes: grantRows.filter((g) => g.companyId === m.companyId).map((g) => g.permissionKey),
  }));

  return {
    email: userRow?.email ?? null,
    // Verified if better-auth marked it so, OR if an IdP authenticated the user
    // (Google Workspace domain-restricted sign-in verifies the address).
    email_verified: Boolean(userRow?.emailVerified) || Boolean(userRow?.idpIssuer),
    name: userRow?.name ?? null,
    idp:
      userRow?.idpIssuer && userRow?.idpSubject
        ? { issuer: userRow.idpIssuer, sub: userRow.idpSubject }
        : null,
    instanceAdmin: Boolean(adminRow),
    companyId: companiesScope.length === 1 ? companiesScope[0]!.id : null,
    companies: companiesScope,
    teams: teamRows.map((t) => t.teamId),
  };
}
