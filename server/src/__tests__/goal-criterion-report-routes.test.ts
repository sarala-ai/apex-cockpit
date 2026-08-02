import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  withDerivedStatus: vi.fn(),
}));
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockCloseReviewApprovals = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  goalService: () => mockGoalService,
  criterionMonitor: () => ({ closeReviewApprovals: mockCloseReviewApprovals }),
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
      userId: "srinivas",
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

const criterion = {
  id: "c1",
  statement: "Agents reach for tools rather than freelancing",
  measure: "tool calls / total assistant turns",
  threshold: "≥80%",
  window: "first four weeks",
  ownerUserId: "srinivas",
  reviewDate: "2026-08-01",
  status: "pending" as const,
  surfacedAt: "2026-08-01T09:00:00Z",
};

function initiative(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    companyId: "company-1",
    title: "Every interface generated from MCP tools",
    level: "initiative",
    status: "active",
    validationCriteria: [criterion],
    ...overrides,
  };
}

describe("reporting against a validation criterion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "goal:update",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockCloseReviewApprovals.mockResolvedValue(undefined);
    mockGoalService.getById.mockResolvedValue(initiative());
    mockGoalService.update.mockImplementation(async (_id: string, data: any) => ({
      ...initiative(),
      ...data,
    }));
    mockGoalService.withDerivedStatus.mockImplementation(async (rows: any[]) =>
      rows.map((row) => ({ ...row, derivedStatus: "active" })),
    );
  });

  it("records a hit with its note and a reviewedAt stamp", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/goals/goal-1/criteria/c1/report")
      .send({ status: "hit", reviewNote: "84% over 1,412 turns in apex-eval" });

    expect(res.status).toBe(200);
    const [reported] = res.body.validationCriteria;
    expect(reported.status).toBe("hit");
    expect(reported.reviewNote).toBe("84% over 1,412 turns in apex-eval");
    expect(Date.parse(reported.reviewedAt)).toBeGreaterThan(0);
    // Everything else about the criterion survives the report.
    expect(reported.threshold).toBe("≥80%");
    expect(reported.ownerUserId).toBe("srinivas");
  });

  it("records a miss just as readily — a monitor that only takes good news is the same failure", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/goals/goal-1/criteria/c1/report")
      .send({ status: "missed", reviewNote: "61%" });

    expect(res.status).toBe(200);
    expect(res.body.validationCriteria[0].status).toBe("missed");
  });

  it("writes the verdict to the activity log", async () => {
    const app = await createApp();
    await request(app).post("/api/goals/goal-1/criteria/c1/report").send({ status: "hit" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "goal.criterion_reported",
        entityType: "goal",
        entityId: "goal-1",
        details: expect.objectContaining({ criterionId: "c1", status: "hit", threshold: "≥80%" }),
      }),
    );
  });

  it("closes the inbox item the sweep raised", async () => {
    const app = await createApp();
    await request(app)
      .post("/api/goals/goal-1/criteria/c1/report")
      .send({ status: "hit", reviewNote: "84%" });

    expect(mockCloseReviewApprovals).toHaveBeenCalledWith(
      "goal-1",
      "c1",
      "srinivas",
      expect.stringContaining("hit"),
    );
  });

  it("leaves the other criteria untouched", async () => {
    mockGoalService.getById.mockResolvedValue(
      initiative({
        validationCriteria: [criterion, { ...criterion, id: "c2", statement: "Second bar" }],
      }),
    );
    const app = await createApp();
    const res = await request(app)
      .post("/api/goals/goal-1/criteria/c2/report")
      .send({ status: "missed" });

    expect(res.body.validationCriteria[0].status).toBe("pending");
    expect(res.body.validationCriteria[1].status).toBe("missed");
  });

  it("rejects a verdict that is not hit or missed", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/goals/goal-1/criteria/c1/report")
      .send({ status: "pending" });
    expect(res.status).toBe(400);
    expect(mockGoalService.update).not.toHaveBeenCalled();
  });

  it("404s an unknown criterion", async () => {
    const app = await createApp();
    const res = await request(app).post("/api/goals/goal-1/criteria/nope/report").send({
      status: "hit",
    });
    expect(res.status).toBe(404);
  });

  it("404s an unknown goal", async () => {
    mockGoalService.getById.mockResolvedValue(null);
    const app = await createApp();
    const res = await request(app).post("/api/goals/goal-1/criteria/c1/report").send({
      status: "hit",
    });
    expect(res.status).toBe(404);
  });

  it("refuses on a goal that is not an initiative", async () => {
    mockGoalService.getById.mockResolvedValue(initiative({ level: "team" }));
    const app = await createApp();
    const res = await request(app).post("/api/goals/goal-1/criteria/c1/report").send({
      status: "hit",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("initiative");
  });

  it("refuses to report against never_registered — nothing was registered to measure", async () => {
    mockGoalService.getById.mockResolvedValue(
      initiative({
        validationCriteria: [
          { id: "c1", statement: "No criteria were registered", status: "never_registered" },
        ],
      }),
    );
    const app = await createApp();
    const res = await request(app).post("/api/goals/goal-1/criteria/c1/report").send({
      status: "hit",
    });
    expect(res.status).toBe(400);
    expect(mockGoalService.update).not.toHaveBeenCalled();
  });
});

describe("criteria and provenance through the goal write paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "goal:update",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue(null);
    mockLogActivity.mockResolvedValue(undefined);
    mockGoalService.create.mockImplementation(async (_companyId: string, data: any) => ({
      id: "goal-1",
      companyId: "company-1",
      ...data,
    }));
    mockGoalService.update.mockImplementation(async (_id: string, data: any) => ({
      ...initiative(),
      ...data,
    }));
    mockGoalService.withDerivedStatus.mockImplementation(async (rows: any[]) =>
      rows.map((row) => ({ ...row, derivedStatus: null })),
    );
  });

  it("round-trips provenance on create", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({
        title: "Every interface generated from MCP tools",
        level: "initiative",
        provenance: { kind: "inferred", source: "47 commits, March to May" },
        validationCriteria: [criterion],
      });

    expect(res.status).toBe(201);
    expect(res.body.provenance).toEqual({ kind: "inferred", source: "47 commits, March to May" });
    expect(res.body.validationCriteria).toHaveLength(1);
  });

  it("rejects a criterion with no reader at the door", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({
        title: "x",
        level: "initiative",
        validationCriteria: [{ ...criterion, ownerUserId: null, ownerAgentId: null }],
      });
    expect(res.status).toBe(400);
    expect(mockGoalService.create).not.toHaveBeenCalled();
  });

  it("rejects a criterion with no reviewDate at the door", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/goals")
      .send({
        title: "x",
        level: "initiative",
        validationCriteria: [{ ...criterion, reviewDate: null }],
      });
    expect(res.status).toBe(400);
  });

  it("rejects criteria and provenance on a PATCH to a non-initiative goal", async () => {
    mockGoalService.getById.mockResolvedValue(initiative({ level: "task" }));
    const app = await createApp();
    const res = await request(app)
      .patch("/api/goals/goal-1")
      .send({ validationCriteria: [criterion], provenance: { kind: "confirmed" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("validationCriteria");
    expect(res.body.error).toContain("provenance");
    expect(mockGoalService.update).not.toHaveBeenCalled();
  });
});
