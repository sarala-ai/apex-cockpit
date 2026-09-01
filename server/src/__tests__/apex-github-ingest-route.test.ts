import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { apexPipelineRoutes } from "../routes/apex-pipeline.js";
import { runGithubIssueIngest } from "../apex/pipeline/github-issue-ingest.js";

vi.mock("../apex/pipeline/github-issue-ingest.js", async () => {
  const actual = await vi.importActual<typeof import("../apex/pipeline/github-issue-ingest.js")>(
    "../apex/pipeline/github-issue-ingest.js",
  );
  return { ...actual, runGithubIssueIngest: vi.fn() };
});
const mockRunGithubIssueIngest = vi.mocked(runGithubIssueIngest);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres github-ingest route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /apex/github-ingest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-ingest-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(companies);
    mockRunGithubIssueIngest.mockReset();
  });

  function app(actor: Express.Request["actor"] = { type: "agent", agentId: "agent-1" }) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use(apexPipelineRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  it("runs the ingest job once and returns its summary", async () => {
    const summary = {
      startedAt: "2026-07-31T00:05:00.000Z",
      finishedAt: "2026-07-31T00:05:03.000Z",
      entries: [
        { companyId: "co-1", companyName: "Acme", repo: "acme/repo", originId: "acme/repo#1", action: "created", detail: "ingested from https://github.com/acme/repo/issues/1" },
      ],
    };
    mockRunGithubIssueIngest.mockResolvedValueOnce(summary as never);

    const res = await request(app()).post("/apex/github-ingest").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(summary);
    expect(mockRunGithubIssueIngest).toHaveBeenCalledTimes(1);
  });

  it("surfaces a job failure as a 500 rather than crashing the route", async () => {
    mockRunGithubIssueIngest.mockRejectedValueOnce(new Error("db unavailable"));

    const res = await request(app()).post("/apex/github-ingest").send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("db unavailable");
  });

  it("requires board-or-agent auth", async () => {
    const res = await request(app({ type: "none", source: "none" } as never)).post("/apex/github-ingest").send({});
    expect(res.status).toBe(403);
  });
});
