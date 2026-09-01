import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  principalPermissionGrants,
  teamMemberships,
  teams,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { buildPrincipalClaims } from "./auth-client.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("buildPrincipalClaims", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-principal-claims-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(principalPermissionGrants);
    await db.delete(teamMemberships);
    await db.delete(teams);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedUser(overrides: Partial<typeof authUsers.$inferInsert> = {}) {
    const now = new Date();
    const id = `user-${randomUUID()}`;
    await db.insert(authUsers).values({ id, name: id, email: `${id}@example.com`, createdAt: now, updatedAt: now, ...overrides });
    return id;
  }

  async function seedCompany() {
    const prefix = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    const [company] = await db.insert(companies).values({ name: `Co ${randomUUID()}`, issuePrefix: prefix }).returning();
    return company.id;
  }

  it("assembles identity, idp, single-company scope, teams and grants", async () => {
    const userId = await seedUser({ idpIssuer: "https://accounts.google.com", idpSubject: "google-sub-123" });
    const companyId = await seedCompany();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });
    const [team] = await db.insert(teams).values({ companyId, name: "Platform", slug: "platform" }).returning();
    await db.insert(teamMemberships).values({ teamId: team.id, userId, role: "lead" });
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "user",
      principalId: userId,
      permissionKey: "tasks:assign",
    });

    const claims = await buildPrincipalClaims(db, userId);

    expect(claims.email).toMatch(/@example\.com$/);
    expect(claims.idp).toEqual({ issuer: "https://accounts.google.com", sub: "google-sub-123" });
    // IdP-authenticated → email is verified (the gateway requires this claim).
    expect(claims.email_verified).toBe(true);
    expect(claims.instanceAdmin).toBe(false);
    // Exactly one company → unambiguous companyId is set.
    expect(claims.companyId).toBe(companyId);
    expect(claims.companies).toHaveLength(1);
    expect(claims.companies[0]).toMatchObject({ id: companyId, role: "owner" });
    expect(claims.companies[0]?.teams).toEqual([{ id: team.id, role: "lead" }]);
    expect(claims.companies[0]?.scopes).toEqual(["tasks:assign"]);
    expect(claims.teams).toEqual([team.id]);
  });

  it("reflects instance admin and null idp for local accounts", async () => {
    const userId = await seedUser();
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });

    const claims = await buildPrincipalClaims(db, userId);

    expect(claims.instanceAdmin).toBe(true);
    expect(claims.idp).toBeNull();
    // Local account, email not verified and no IdP → email_verified is false.
    expect(claims.email_verified).toBe(false);
    expect(claims.companyId).toBeNull();
    expect(claims.companies).toEqual([]);
    expect(claims.teams).toEqual([]);
  });

  it("leaves companyId null when the user spans multiple companies", async () => {
    const userId = await seedUser();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    for (const companyId of [companyA, companyB]) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
        membershipRole: "member",
      });
    }

    const claims = await buildPrincipalClaims(db, userId);

    expect(claims.companyId).toBeNull();
    expect(claims.companies.map((c) => c.id).sort()).toEqual([companyA, companyB].sort());
  });
});
