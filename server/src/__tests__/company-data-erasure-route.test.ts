/**
 * The erasure endpoint end to end: the wiring, the owner gate, and the fact
 * that the DEFAULT request writes nothing.
 */
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, createDb, goals, issues, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { companyRoutes } from "../routes/companies.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping embedded Postgres company data erasure route tests on this host: ${support.reason ?? "unsupported environment"}`,
  );
}

function boardActor(companyId: string, role: string): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-1",
    source: "session",
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

describeDb("POST /api/companies/:companyId/data-erasure", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("company-data-erasure-route-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.execute(
      "truncate table issues, projects, goals, companies restart identity cascade" as never,
    );
  });

  async function seed() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Erasable", slug: "erasable", issuePrefix: "ERS" })
      .returning();
    const [initiative] = await db
      .insert(goals)
      .values({ companyId: company.id, title: "Initiative", level: "initiative" })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({ companyId: company.id, name: "Project", goalId: initiative.id })
      .returning();
    await db.insert(issues).values({ companyId: company.id, title: "Issue", projectId: project.id });
    return company;
  }

  it("previews by default, writing nothing", async () => {
    const company = await seed();
    const app = createApp(db, boardActor(company.id, "owner"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/data-erasure`)
      .send({ scope: "company" })
      .expect(200);

    expect(res.body.dryRun).toBe(true);
    expect(res.body.activityId).toBeNull();
    expect(res.body.deletes.find((entry: { table: string }) => entry.table === "issues").rows).toBe(1);
    expect(res.body.preserved).toContain("company_memberships");
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(1);
  }, 60_000);

  it("erases when the slug is supplied", async () => {
    const company = await seed();
    const app = createApp(db, boardActor(company.id, "owner"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/data-erasure`)
      .send({ scope: "company", confirm: "erasable" })
      .expect(200);

    expect(res.body.dryRun).toBe(false);
    expect(res.body.activityId).toBeTruthy();
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(0);
    expect(await db.select().from(goals).where(eq(goals.companyId, company.id))).toHaveLength(0);
    // The company survives — this empties a board, it does not delete a tenant.
    expect(await db.select().from(companies).where(eq(companies.id, company.id))).toHaveLength(1);
  }, 60_000);

  it("422s on a confirmation that is not the slug", async () => {
    const company = await seed();
    const app = createApp(db, boardActor(company.id, "owner"));

    await request(app)
      .post(`/api/companies/${company.id}/data-erasure`)
      .send({ scope: "company", confirm: "true" })
      .expect(422);

    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(1);
  }, 60_000);

  it("403s an operator", async () => {
    const company = await seed();
    const app = createApp(db, boardActor(company.id, "operator"));

    await request(app)
      .post(`/api/companies/${company.id}/data-erasure`)
      .send({ scope: "company", confirm: "erasable" })
      .expect(403);

    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(1);
  }, 60_000);

  it("403s an agent key even for its own company", async () => {
    const company = await seed();
    const app = createApp(db, {
      type: "agent",
      agentId: "00000000-0000-0000-0000-000000000001",
      companyId: company.id,
      source: "agent_key",
    } as Express.Request["actor"]);

    await request(app)
      .post(`/api/companies/${company.id}/data-erasure`)
      .send({ scope: "company", confirm: "erasable" })
      .expect(403);
  }, 60_000);

  it("400s an unknown scope rather than guessing one", async () => {
    const company = await seed();
    const app = createApp(db, boardActor(company.id, "owner"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/data-erasure`)
      .send({ scope: "everything", confirm: "erasable" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.select().from(issues).where(eq(issues.companyId, company.id))).toHaveLength(1);
  }, 60_000);

  it("returns the block, not a 500, when initiatives still hold projects", async () => {
    const company = await seed();
    const app = createApp(db, boardActor(company.id, "owner"));

    const res = await request(app)
      .post(`/api/companies/${company.id}/data-erasure`)
      .send({ scope: "initiatives", confirm: "erasable" })
      .expect(200);

    expect(res.body.blocked).not.toBeNull();
    expect(res.body.blocked.counts).toContainEqual({ table: "projects", rows: 1 });
    expect(res.body.activityId).toBeNull();
    expect(await db.select().from(goals).where(eq(goals.companyId, company.id))).toHaveLength(1);
  }, 60_000);
});
