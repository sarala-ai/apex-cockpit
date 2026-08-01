import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, approvals, companies, createDb, issueApprovals, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { apexFlowRoutes } from "../routes/apex-flows.js";
import { loadFlowDefinition, listFlowDefinitions } from "../apex/flow/definition.js";

// The route builds a real coordinator; only the CLI seam (definition loading)
// and node execution are mocked. Node execution is irrelevant here: the test
// flow's first node is a gate, so the loop parks without shelling anything.
vi.mock("../apex/flow/definition.js", async () => {
  const actual = await vi.importActual<typeof import("../apex/flow/definition.js")>(
    "../apex/flow/definition.js",
  );
  return { ...actual, loadFlowDefinition: vi.fn(), listFlowDefinitions: vi.fn() };
});
const mockLoad = vi.mocked(loadFlowDefinition);
const mockList = vi.mocked(listFlowDefinitions);

const GATED_FLOW = {
  path: "/f/gated.yml",
  flow: {
    name: "gated",
    version: "1.0",
    description: "gated",
    ticket_type: "bug",
    nodes: [
      { id: "gate1", kind: "gate" as const, gate: { mode: "approve" as const, prompt: "Review" }, on_fail: "pause" },
    ],
  },
};

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres apex-flows route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("apex flows routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex-flows-route-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
    mockLoad.mockReset();
    mockList.mockReset();
  });

  function app(
    actor: Express.Request["actor"] = { type: "board", userId: "user-1", source: "local_implicit" } as never,
  ) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use(apexFlowRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  async function seedIssue() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "APEX" });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "flow route issue" });
    return { companyId, issueId };
  }

  it("GET /apex/flows returns the definitions listing", async () => {
    mockList.mockResolvedValue([
      { name: "chore", path: "/f/chore.yml", ticket_type: "chore", node_count: 3, gate_count: 0 },
    ]);
    const res = await request(app()).get("/apex/flows");
    expect(res.status).toBe(200);
    expect(res.body.flows).toHaveLength(1);
    expect(res.body.flows[0].name).toBe("chore");
  });

  it("POST /apex/flows/start attaches the flow at node 0 and returns 202", async () => {
    const { issueId } = await seedIssue();
    mockLoad.mockResolvedValue(GATED_FLOW as never);

    const res = await request(app()).post("/apex/flows/start").send({ issueId, flowName: "gated" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      issueId,
      flowName: "gated",
      flowNodeId: "gate1",
      flowStatus: "running",
    });

    // Wait for the background loop to park at the gate.
    const deadline = Date.now() + 5_000;
    let row: { flowStatus: string | null; flowNodeId: string | null } | undefined;
    while (Date.now() < deadline) {
      [row] = await db
        .select({ flowStatus: issues.flowStatus, flowNodeId: issues.flowNodeId })
        .from(issues)
        .where(eq(issues.id, issueId));
      if (row?.flowStatus === "waiting_gate") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(row).toMatchObject({ flowStatus: "waiting_gate", flowNodeId: "gate1" });
  });

  it("rejects non-board actors", async () => {
    const { issueId } = await seedIssue();
    const res = await request(app({ type: "agent", agentId: "a", companyId: "c" } as never))
      .post("/apex/flows/start")
      .send({ issueId, flowName: "gated" });
    expect(res.status).toBe(403);
  });

  it("404s an unknown issue", async () => {
    mockLoad.mockResolvedValue(GATED_FLOW as never);
    const res = await request(app())
      .post("/apex/flows/start")
      .send({ issueId: randomUUID(), flowName: "gated" });
    expect(res.status).toBe(404);
  });

  it("validates the body", async () => {
    const res = await request(app()).post("/apex/flows/start").send({ flowName: "gated" });
    expect(res.status).toBe(400);
  });

  it("409s when a flow is already active on the issue", async () => {
    const { issueId } = await seedIssue();
    mockLoad.mockResolvedValue(GATED_FLOW as never);
    await db
      .update(issues)
      .set({ flowName: "gated", flowNodeId: "gate1", flowStatus: "waiting_gate" })
      .where(eq(issues.id, issueId));

    const res = await request(app()).post("/apex/flows/start").send({ issueId, flowName: "gated" });
    expect(res.status).toBe(409);
  });
});
