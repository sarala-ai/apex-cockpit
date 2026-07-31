import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, resourceAttributions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { apexObserveRoutes } from "../routes/apex-observe.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres attribution route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REPORT = {
  exact: [
    {
      resource: {
        name: "//storage.googleapis.com/finpilot-dev-uploads",
        displayName: "finpilot-dev-uploads",
        attribution: { status: "label", workflow: "gcp_storage_setup", repo: "sarala-ai--finpilot", env: "dev" },
      },
      workflow: "finpilot_infrastructure",
      workflow_path: ".apex/workflows/finpilot-infrastructure.yml",
      repo: "sarala-ai/FinPilot",
      step_name: "create_upload_bucket",
      inputs: { environment: "dev" },
      evidence: ".github/workflows/deploy-environment.yml:181",
    },
    {
      resource: { name: "//secretmanager.googleapis.com/projects/1/secrets/finpilot-jwt-secret" },
      workflow: "finpilot_infrastructure",
      repo: "sarala-ai/FinPilot",
      inputs: { environment: "dev" },
      evidence: ".github/workflows/deploy-environment.yml:181",
    },
  ],
  // Never imported — only `exact` is (spec: resource-attribution-mapping).
  proposals: [
    { resource: { name: "//storage.googleapis.com/should-not-import" }, workflow: "guess", repo: "org/x" },
  ],
  drift: [{ resource: { name: "//storage.googleapis.com/also-should-not-import" } }],
};

describeEmbeddedPostgres("attribution routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attribution-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(resourceAttributions);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"] = { type: "agent", agentId: "agent-1" }) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use(apexObserveRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Attribution Co") {
    const [company] = await db
      .insert(companies)
      .values({ name, issuePrefix: "ATTR" })
      .returning();
    return company!;
  }

  describe("POST /observe/attribution/import", () => {
    it("imports the report's exact mappings as auto_mapped rows, skipping proposals/drift", async () => {
      const company = await seedCompany();
      const res = await request(app()).post("/observe/attribution/import").send({
        companyId: company.id,
        projectId: "finpilot-dev",
        report: REPORT,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ imported: 2, updated: 0, skippedManual: 0, skippedNoResource: 0 });

      const rows = await db.select().from(resourceAttributions).where(eq(resourceAttributions.projectId, "finpilot-dev"));
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.source === "auto_mapped")).toBe(true);
      expect(rows.find((r) => r.resourceUri.includes("should-not-import"))).toBeUndefined();

      const bucketRow = rows.find((r) => r.resourceUri.includes("uploads"))!;
      expect(bucketRow).toMatchObject({
        workflow: "finpilot_infrastructure",
        repo: "sarala-ai/FinPilot",
        env: "dev",
        confidence: "exact",
      });
    });

    it("is idempotent: re-importing the same report updates in place, no duplicate rows", async () => {
      const company = await seedCompany();
      const body = { companyId: company.id, projectId: "finpilot-dev", report: REPORT };

      await request(app()).post("/observe/attribution/import").send(body);
      const second = await request(app()).post("/observe/attribution/import").send(body);

      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ imported: 0, updated: 2 });

      const rows = await db.select().from(resourceAttributions).where(eq(resourceAttributions.projectId, "finpilot-dev"));
      expect(rows).toHaveLength(2);
    });

    it("never overwrites a row a human has since promoted to manual", async () => {
      const company = await seedCompany();
      const resourceUri = "//storage.googleapis.com/finpilot-dev-uploads";
      await request(app()).post("/observe/attribution/import").send({
        companyId: company.id,
        projectId: "finpilot-dev",
        report: REPORT,
      });
      await request(app()).post("/observe/attribution/manual").send({
        companyId: company.id,
        projectId: "finpilot-dev",
        resourceUri,
        assetType: "storage.googleapis.com/Bucket",
        workflow: "human_override",
        repo: "org/human-repo",
        env: "prod",
      });

      const res = await request(app()).post("/observe/attribution/import").send({
        companyId: company.id,
        projectId: "finpilot-dev",
        report: REPORT,
      });
      expect(res.status).toBe(200);
      expect(res.body.skippedManual).toBe(1);

      const [row] = await db
        .select()
        .from(resourceAttributions)
        .where(eq(resourceAttributions.resourceUri, resourceUri));
      expect(row).toMatchObject({ source: "manual", workflow: "human_override", repo: "org/human-repo", env: "prod" });
    });
  });

  describe("POST /observe/attribution/manual", () => {
    it("upserts a manual row and resolves decidedBy from the acting agent", async () => {
      const company = await seedCompany();
      const res = await request(app({ type: "agent", agentId: "agent-42" }))
        .post("/observe/attribution/manual")
        .send({
          companyId: company.id,
          projectId: "finpilot-dev",
          resourceUri: "//storage.googleapis.com/finpilot-dev-uploads",
          assetType: "storage.googleapis.com/Bucket",
          workflow: "manual_wf",
          repo: "org/manual-repo",
          env: "prod",
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        source: "manual",
        workflow: "manual_wf",
        repo: "org/manual-repo",
        env: "prod",
        decidedBy: "agent-42",
      });
    });

    it("upserts on (projectId, resourceUri) rather than inserting duplicates", async () => {
      const company = await seedCompany();
      const body = {
        companyId: company.id,
        projectId: "finpilot-dev",
        resourceUri: "//storage.googleapis.com/finpilot-dev-uploads",
        assetType: "storage.googleapis.com/Bucket",
        workflow: "first",
        repo: "org/first",
        env: "dev",
      };
      await request(app()).post("/observe/attribution/manual").send(body);
      await request(app()).post("/observe/attribution/manual").send({ ...body, workflow: "second", env: "prod" });

      const rows = await db
        .select()
        .from(resourceAttributions)
        .where(eq(resourceAttributions.resourceUri, body.resourceUri));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ workflow: "second", env: "prod" });
    });
  });
});
