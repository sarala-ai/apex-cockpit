import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  cloudScopeBindings,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  documents,
  issues,
  principalPermissionGrants,
  routineDocuments,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";
import { companyService } from "../services/companies.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company delete route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function boardActor(companyId: string, role: "admin" | "operator" | "viewer" = "admin") {
  return {
    type: "board" as const,
    userId: "user-1",
    source: "session" as const,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("DELETE /api/companies/:companyId", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-delete-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(cloudScopeBindings);
    await db.delete(issues);
    await db.delete(routineDocuments);
    await db.delete(documents);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySkills);
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // POST /companies always stamps the creating user as the company default
  // responsible user before seeding; the seeded routine is accountable to it.
  function createCompany(data: Parameters<ReturnType<typeof companyService>["create"]>[0]) {
    return companyService(db).create({ defaultResponsibleUserId: "user-1", ...data });
  }

  it("(a) deletes an empty company — including one with only the seeded agent+routine — cleanly", async () => {
    const created = await createCompany({ name: "Empty Co" });

    // Sanity: the seeded bundle exists before delete.
    const seededAgents = await db.select().from(agents).where(eq(agents.companyId, created.id));
    expect(seededAgents.length).toBeGreaterThan(0);
    const seededRoutines = await db.select().from(routines).where(eq(routines.companyId, created.id));
    expect(seededRoutines.length).toBeGreaterThan(0);

    const app = createApp(db, boardActor(created.id));
    const response = await request(app).delete(`/api/companies/${created.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const remaining = await db.select().from(companies).where(eq(companies.id, created.id));
    expect(remaining).toHaveLength(0);
  });

  it("(b) blocks deletion with 409 + counts when the company has substantive data, and does not delete", async () => {
    const created = await createCompany({ name: "Company With Issue" });

    await db.insert(issues).values({
      id: randomUUID(),
      companyId: created.id,
      title: "Some real work",
      status: "backlog",
    });

    const app = createApp(db, boardActor(created.id));
    const response = await request(app).delete(`/api/companies/${created.id}`);

    expect(response.status).toBe(409);
    expect(response.body.requiresConfirmation).toBe(true);
    expect(response.body.counts).toMatchObject({ issues: 1 });

    const stillThere = await db.select().from(companies).where(eq(companies.id, created.id));
    expect(stillThere).toHaveLength(1);
  });

  it("(c) deletes successfully when confirm=true is passed for a company with data", async () => {
    const created = await createCompany({ name: "Company With Issue Confirmed" });

    await db.insert(issues).values({
      id: randomUUID(),
      companyId: created.id,
      title: "Some real work",
      status: "backlog",
    });

    const app = createApp(db, boardActor(created.id));
    const response = await request(app).delete(`/api/companies/${created.id}?confirm=true`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const remaining = await db.select().from(companies).where(eq(companies.id, created.id));
    expect(remaining).toHaveLength(0);
  });

  it("(c-alt) also accepts confirm:true in the JSON body", async () => {
    const created = await createCompany({ name: "Company With Issue Body Confirm" });

    await db.insert(issues).values({
      id: randomUUID(),
      companyId: created.id,
      title: "Some real work",
      status: "backlog",
    });

    const app = createApp(db, boardActor(created.id));
    const response = await request(app)
      .delete(`/api/companies/${created.id}`)
      .send({ confirm: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });

    const remaining = await db.select().from(companies).where(eq(companies.id, created.id));
    expect(remaining).toHaveLength(0);
  });

  it("(d) cleans up cloud_scope_bindings rows for the company after a successful delete", async () => {
    const created = await createCompany({ name: "Company With Scope Binding" });

    await db.insert(cloudScopeBindings).values({
      id: randomUUID(),
      scopeType: "company",
      scopeId: created.id,
      gcpProjects: ["my-gcp-project"],
      githubRepos: ["org/repo"],
    });

    const before = await db
      .select()
      .from(cloudScopeBindings)
      .where(and(eq(cloudScopeBindings.scopeType, "company"), eq(cloudScopeBindings.scopeId, created.id)));
    expect(before).toHaveLength(1);

    const app = createApp(db, boardActor(created.id));
    const response = await request(app).delete(`/api/companies/${created.id}`);
    expect(response.status).toBe(200);

    const after = await db
      .select()
      .from(cloudScopeBindings)
      .where(and(eq(cloudScopeBindings.scopeType, "company"), eq(cloudScopeBindings.scopeId, created.id)));
    expect(after).toHaveLength(0);
  });
});
