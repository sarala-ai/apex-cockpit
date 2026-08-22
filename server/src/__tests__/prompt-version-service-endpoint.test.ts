/**
 * Service-to-service endpoint GET /prompt-versions/:versionId — the read
 * apex-eval calls to resolve a judge's instruction from a prompt version.
 *
 * Covers the content shape, the 404 path, and the shared-secret guard: when
 * APEX_COCKPIT_API_KEY is set the caller must present it as a bearer token;
 * when unset the route is open (local dev). The guard reads the env per
 * request, so each test sets/clears it directly.
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companyPrompts, companyPromptVersions, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyPromptRoutes } from "../routes/company-prompts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping prompt-version endpoint tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /prompt-versions/:versionId", () => {
  let app!: express.Express;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let versionId!: string;
  const CONTENT = "You are a strict judge. {{task}}";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-prompt-endpoint-");
    const db = createDb(tempDb.connectionString);
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Prompt Endpoint Test Co",
      issuePrefix: "PET",
      requireBoardApprovalForNewAgents: false,
    });
    const [prompt] = await db
      .insert(companyPrompts)
      .values({ companyId, name: "Judge", slug: "judge" })
      .returning();
    const [version] = await db
      .insert(companyPromptVersions)
      .values({ companyId, promptId: prompt.id, revisionNumber: 1, content: CONTENT, variables: [] })
      .returning();
    versionId = version.id;

    app = express();
    app.use(express.json());
    app.use(companyPromptRoutes(db));
  }, 20_000);

  afterEach(() => {
    delete process.env.APEX_COCKPIT_API_KEY;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns the version content when the service secret is unset (local dev)", async () => {
    const res = await request(app).get(`/prompt-versions/${versionId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(versionId);
    expect(res.body.content).toBe(CONTENT);
  });

  it("404s an unknown version id", async () => {
    const res = await request(app).get(`/prompt-versions/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("401s when the secret is set and no bearer token is presented", async () => {
    process.env.APEX_COCKPIT_API_KEY = "s3cret";
    const res = await request(app).get(`/prompt-versions/${versionId}`);
    expect(res.status).toBe(401);
  });

  it("401s when the secret is set and the bearer token is wrong", async () => {
    process.env.APEX_COCKPIT_API_KEY = "s3cret";
    const res = await request(app)
      .get(`/prompt-versions/${versionId}`)
      .set("Authorization", "Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("returns content when the secret is set and the correct bearer token is presented", async () => {
    process.env.APEX_COCKPIT_API_KEY = "s3cret";
    const res = await request(app)
      .get(`/prompt-versions/${versionId}`)
      .set("Authorization", "Bearer s3cret");
    expect(res.status).toBe(200);
    expect(res.body.content).toBe(CONTENT);
  });
});
