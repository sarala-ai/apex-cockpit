import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOAL_CLOSURES,
  deriveInitiativeStatus,
  summarizeInitiativeProjects,
} from "@paperclipai/shared";

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  withDerivedStatus: vi.fn(),
}));

/** Project statuses the fake derivation should see, per goal id. */
const projectStatusesByGoalId = vi.hoisted(() => new Map<string, string[]>());

const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockTelemetryTrack = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
}));

async function createApp() {
  const { errorHandler } = await import("../middleware/index.js");
  const { goalRoutes } = await import("../routes/goals.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", goalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const assumptions = [
  {
    id: "a1",
    statement: "Extraction is accurate enough on real documents",
    type: "technical",
    status: "retired",
    evidence: "6.2% error over 214 documents",
  },
  {
    id: "a2",
    statement: "Shipped consent covers proactive contact",
    type: "regulatory",
    status: "blocked",
  },
];

/** Echoes the create/update payload the way the real service round-trips it. */
function echoRow(payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    companyId: "company-1",
    title: "Proactive alerts",
    description: null,
    level: "task",
    status: "planned",
    parentId: null,
    ownerAgentId: null,
    closure: null,
    closureReason: null,
    assumptions: null,
    budget: null,
    stopCondition: null,
    hypothesis: null,
    hypotheses: null,
    hold: null,
    ...payload,
    ...overrides,
  };
}

describe("goal routes — the initiative object", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "goal:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: mockTelemetryTrack });
    mockLogActivity.mockResolvedValue(undefined);
    mockGoalService.create.mockImplementation(async (_companyId: string, data: any) =>
      echoRow(data),
    );
    // The real update returns the whole stored row, not just the patch.
    mockGoalService.update.mockImplementation(async (_id: string, data: any) => {
      const existing = (await mockGoalService.getById(_id)) ?? {};
      return echoRow({ ...existing, ...data });
    });
    projectStatusesByGoalId.clear();
    // Stands in for the real join: same derivation, statuses supplied per test.
    mockGoalService.withDerivedStatus.mockImplementation(async (rows: any[]) =>
      rows.map((row) => ({
        ...row,
        derivedStatus:
          row.level === "initiative"
            ? deriveInitiativeStatus(projectStatusesByGoalId.get(row.id) ?? [], {
                held: Boolean(row.hold),
              })
            : null,
        projectCounts:
          row.level === "initiative"
            ? summarizeInitiativeProjects(projectStatusesByGoalId.get(row.id) ?? [])
            : null,
      })),
    );
  });

  it("round-trips a full initiative through create, assumptions included", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({
        title: "Proactive alerts",
        level: "initiative",
        hypothesis: "Households act on proactive alerts",
        budget: "two weeks",
        stopCondition: "extraction error over 10%, or under 30% second-alert engagement",
        assumptions,
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.level).toBe("initiative");
    expect(res.body.hypothesis).toBe("Households act on proactive alerts");
    expect(res.body.budget).toBe("two weeks");
    expect(res.body.stopCondition).toContain("extraction error over 10%");
    expect(res.body.assumptions).toHaveLength(2);
    expect(res.body.assumptions[0].evidence).toBe("6.2% error over 214 documents");
    expect(res.body.assumptions[1].status).toBe("blocked");
  });

  it("creates a bare initiative — no hypothesis, no assumptions", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({ title: "Import APEX history", level: "initiative" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.hypothesis).toBeNull();
    expect(res.body.assumptions).toBeNull();
  });

  it("returns the initiative fields on GET", async () => {
    mockGoalService.getById.mockResolvedValue(
      echoRow({ level: "initiative", budget: "two weeks", assumptions, hypothesis: "h" }),
    );
    const app = await createApp();
    const res = await request(app).get("/api/goals/goal-1");

    expect(res.status).toBe(200);
    expect(res.body.budget).toBe("two weeks");
    expect(res.body.hypothesis).toBe("h");
    expect(res.body.assumptions).toHaveLength(2);
  });

  it.each(GOAL_CLOSURES)("closes an initiative as %s, with its reason", async (closure) => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative" }));
    const app = await createApp();
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ closure, closureReason: "the stop condition fired in week five" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.closure).toBe(closure);
    expect(res.body.closureReason).toBe("the stop condition fired in week five");
  });

  it.each(["company", "team", "agent", "task"])(
    "leaves a %s goal alone — its statuses still work and closure is refused",
    async (level) => {
      mockGoalService.getById.mockResolvedValue(echoRow({ level }));
      const app = await createApp();

      const ok = await request(app).patch("/api/goals/goal-1").send({ status: "achieved" });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.status).toBe("achieved");

      const rejected = await request(app)
        .patch("/api/goals/goal-1")
        .send({ closure: "validated" });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain("initiative");
      expect(mockGoalService.update).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses initiative fields at create time on a non-initiative goal", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({ title: "Team goal", level: "team", stopCondition: "never" });

    expect(res.status).toBe(400);
    expect(mockGoalService.create).not.toHaveBeenCalled();
  });

  it("accepts initiative fields on a PATCH that promotes the goal to an initiative", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "task" }));
    const app = await createApp();
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ level: "initiative", budget: "two weeks" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.budget).toBe("two weeks");
  });

  it("reports an initiative to telemetry as 'other' — the generated contract has no such member", async () => {
    const app = await createApp();
    await request(app)
      .post("/api/companies/company-1/goals")
      .send({ title: "Proactive alerts", level: "initiative" });

    expect(mockTelemetryTrack).toHaveBeenCalledWith("goal.created", { goal_level: "other" });
  });

  it("reports an initiative's status from its projects, not from its column", async () => {
    // Stored status says "planned"; the projects say otherwise.
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative", status: "planned" }));
    projectStatusesByGoalId.set("goal-1", ["completed", "on_hold", "backlog", "backlog"]);
    const app = await createApp();
    const res = await request(app).get("/api/goals/goal-1");

    expect(res.status).toBe(200);
    expect(res.body.derivedStatus).toBe("active");
  });

  it("changes the derived status when a project is held or added", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative" }));
    const app = await createApp();

    projectStatusesByGoalId.set("goal-1", ["in_progress"]);
    expect((await request(app).get("/api/goals/goal-1")).body.derivedStatus).toBe("active");

    projectStatusesByGoalId.set("goal-1", ["on_hold"]);
    expect((await request(app).get("/api/goals/goal-1")).body.derivedStatus).toBe("on_hold");

    projectStatusesByGoalId.set("goal-1", ["on_hold", "completed"]);
    expect((await request(app).get("/api/goals/goal-1")).body.derivedStatus).toBe("active");
  });

  it("reports planned for a childless initiative rather than failing", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative" }));
    const app = await createApp();
    const res = await request(app).get("/api/goals/goal-1");

    expect(res.status).toBe(200);
    expect(res.body.derivedStatus).toBe("planned");
  });

  it("gives non-initiative goals no derived status at all", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "team", status: "active" }));
    const app = await createApp();
    const res = await request(app).get("/api/goals/goal-1");

    expect(res.body.derivedStatus).toBeNull();
    expect(res.body.status).toBe("active");
  });

  it("refuses a hand-edited status on an initiative — it would compete with the derivation", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative" }));
    const app = await createApp();
    const res = await request(app).patch("/api/goals/goal-1").send({ status: "achieved" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("derived");
    expect(mockGoalService.update).not.toHaveBeenCalled();
  });

  it("keeps closure independent of the derived status — a decision, not a consequence", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative" }));
    projectStatusesByGoalId.set("goal-1", ["in_progress", "backlog"]);
    const app = await createApp();
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ closure: "stopped", closureReason: "the stop condition fired" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.closure).toBe("stopped");
    // The projects have not moved, so the derived reading has not either.
    expect(res.body.derivedStatus).toBe("active");
  });

  it("a hold overrides the derived reading, and says why", async () => {
    // Two real initiatives read `active` because two of their projects had
    // completed, when the honest reading was: valid, not now.
    const hold = { reason: "waiting on a local model worth running", since: "2026-07-02" };
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative" }));
    projectStatusesByGoalId.set("goal-1", ["completed", "completed", "backlog"]);
    const app = await createApp();

    expect((await request(app).get("/api/goals/goal-1")).body.derivedStatus).toBe("active");

    const res = await request(app).patch("/api/goals/goal-1").send({ hold });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.hold).toEqual(hold);
    expect(res.body.derivedStatus).toBe("on_hold");
    // The projects did not move, and the counts still say so.
    expect(res.body.projectCounts.completed).toBe(2);
  });

  it("refuses a hold with no reason", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative" }));
    const app = await createApp();
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ hold: { since: "2026-07-02" } });
    expect(res.status).toBe(400);
    expect(mockGoalService.update).not.toHaveBeenCalled();
  });

  it("releases a hold with null, and the derivation takes over again", async () => {
    mockGoalService.getById.mockResolvedValue(
      echoRow({ level: "initiative", hold: { reason: "not now", since: "2026-07-02" } }),
    );
    projectStatusesByGoalId.set("goal-1", ["in_progress"]);
    const app = await createApp();
    const res = await request(app).patch("/api/goals/goal-1").send({ hold: null });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.derivedStatus).toBe("active");
  });

  it("refuses a hold on a goal that is not an initiative", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "team" }));
    const app = await createApp();
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ hold: { reason: "not now", since: "2026-07-02" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("hold");
  });

  it("round-trips structured hypotheses, verdicts included", async () => {
    const hypotheses = [
      {
        id: "h1",
        statement: "An MCP-only interface is enough",
        verdict: "falsified",
        evidence: "two of three projects cancelled; nothing generated from tools",
        testedAt: "2026-05-30",
      },
      { id: "h2", statement: "Local models are cheap enough", verdict: "untested" },
    ];
    projectStatusesByGoalId.set("goal-1", []);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({ title: "Every interface generated from MCP tools", level: "initiative", hypotheses });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.hypotheses).toHaveLength(2);
    expect(res.body.hypotheses[0].verdict).toBe("falsified");
  });

  it("refuses a verdict that exceeds its evidence", async () => {
    projectStatusesByGoalId.set("goal-1", []);
    const app = await createApp();
    const res = await request(app).post("/api/companies/company-1/goals").send({
      title: "x",
      level: "initiative",
      hypotheses: [{ id: "h1", statement: "y", verdict: "supported" }],
    });
    expect(res.status).toBe(400);
  });

  it("MCP-first regression: cancelled projects keep the initiative off `delivered`", async () => {
    // One project shipped, two failed and were cancelled. The old derivation
    // dropped the cancelled ones and reported `delivered` for an initiative
    // whose own sentence had been falsified; the importer had to work around it
    // by closing it as `revised`.
    mockGoalService.getById.mockResolvedValue(
      echoRow({ level: "initiative", title: "Every interface generated from MCP tools" }),
    );
    projectStatusesByGoalId.set("goal-1", ["completed", "cancelled", "cancelled"]);
    const app = await createApp();
    const res = await request(app).get("/api/goals/goal-1");

    expect(res.body.derivedStatus).toBe("partial");
    expect(res.body.projectCounts.cancelled).toBe(2);
    expect(res.body.projectCounts.total).toBe(3);
  });

  it("counts built-but-unexercised projects beside the status", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "initiative" }));
    projectStatusesByGoalId.set("goal-1", ["built", "built", "completed"]);
    const app = await createApp();
    const res = await request(app).get("/api/goals/goal-1");

    expect(res.body.derivedStatus).toBe("delivered");
    expect(res.body.projectCounts.built).toBe(2);
    expect(res.body.projectCounts.completed).toBe(1);
  });

  it("gives non-initiative goals no project counts either", async () => {
    mockGoalService.getById.mockResolvedValue(echoRow({ level: "team" }));
    const app = await createApp();
    expect((await request(app).get("/api/goals/goal-1")).body.projectCounts).toBeNull();
  });

  it("never accepts a derivedStatus from the client", async () => {
    projectStatusesByGoalId.set("goal-1", []);
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({ title: "Proactive alerts", level: "initiative", derivedStatus: "delivered" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.derivedStatus).toBe("planned");
    expect(mockGoalService.create.mock.calls[0]?.[1]).not.toHaveProperty("derivedStatus");
  });

  it("still reports the levels the contract does know", async () => {
    const app = await createApp();
    await request(app)
      .post("/api/companies/company-1/goals")
      .send({ title: "Team goal", level: "team" });

    expect(mockTelemetryTrack).toHaveBeenCalledWith("goal.created", { goal_level: "team" });
  });
});
