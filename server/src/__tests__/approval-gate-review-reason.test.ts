/**
 * A gate is a review stage, and a review stage requires a reason for any
 * non-approve decision — the same rule a review stage enforces via
 * `requireRejectReason` / `requireRequestChangesReason`
 * (server/src/services/pipelines.ts `reviewCase`).
 *
 * Two things are load-bearing and tested here rather than assumed:
 * - the reason is required for gate approvals ONLY. Every other approval type
 *   keeps its optional note; this is a review-stage rule, not a new global
 *   ceremony.
 * - the check runs BEFORE the approval is resolved, so a reasonless decision
 *   never becomes a decided-but-unexplained ledger entry that the case then
 *   cannot act on.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
}));

const mockDecideStageGate = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    activityService: () => ({ forIssue: vi.fn().mockResolvedValue([]) }),
    heartbeatService: () => ({ wakeup: vi.fn() }),
    issueApprovalService: () => ({
      listIssuesForApproval: vi.fn().mockResolvedValue([]),
      linkManyForApproval: vi.fn(),
    }),
    logActivity: mockLogActivity,
    secretService: () => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }),
  }));
  vi.doMock("../services/pipelines.js", async () => {
    const actual = await vi.importActual<typeof import("../services/pipelines.js")>(
      "../services/pipelines.js",
    );
    return { ...actual, pipelineService: () => ({ decideStageGate: mockDecideStageGate }) };
  });
}

const GATE_APPROVAL = {
  id: "approval-1",
  companyId: "company-1",
  // The approval type keeps the string it has always had: renaming it would
  // mean a payload migration over pending approvals to save a word.
  type: "flow_gate",
  status: "pending",
  payload: {
    caseId: "case-1",
    issueId: "issue-1",
    nodeId: "diff_gate",
    stepKey: "diff_gate",
    flowName: "feature",
  },
};

async function createApp() {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "founder",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("gate decisions require a reason", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/pipelines.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockDecideStageGate.mockResolvedValue({ transitioned: false });
  });

  for (const [label, path] of [
    ["reject", "reject"],
    ["request changes", "request-revision"],
  ] as const) {
    it(`${label}: a missing note is a classified 400 and the approval is never resolved`, async () => {
      mockApprovalService.getById.mockResolvedValue(GATE_APPROVAL);

      const res = await request(await createApp()).post(`/api/approvals/approval-1/${path}`).send({});

      expect(res.status).toBe(400);
      expect(res.body.details).toMatchObject({ errorType: "gate_review_reason_required" });
      expect(mockApprovalService.reject).not.toHaveBeenCalled();
      expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
      expect(mockDecideStageGate).not.toHaveBeenCalled();
    });

    it(`${label}: a whitespace-only note is a 400 too`, async () => {
      mockApprovalService.getById.mockResolvedValue(GATE_APPROVAL);

      const res = await request(await createApp())
        .post(`/api/approvals/approval-1/${path}`)
        .send({ decisionNote: "   \n  " });

      expect(res.status).toBe(400);
      expect(mockApprovalService.reject).not.toHaveBeenCalled();
      expect(mockApprovalService.requestRevision).not.toHaveBeenCalled();
    });
  }

  it("reject with a reason resolves the approval and stops the case", async () => {
    mockApprovalService.getById.mockResolvedValue(GATE_APPROVAL);
    mockApprovalService.reject.mockResolvedValue({
      approval: { ...GATE_APPROVAL, status: "rejected" },
      applied: true,
    });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({ decisionNote: "This should not ship." });

    expect(res.status).toBe(200);
    expect(mockDecideStageGate).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "reject", reason: "This should not ship." }),
    );
  });

  it("request-revision on a gate IS the request_changes decision, and carries the reason", async () => {
    mockApprovalService.getById.mockResolvedValue(GATE_APPROVAL);
    mockApprovalService.requestRevision.mockResolvedValue({
      ...GATE_APPROVAL,
      status: "revision_requested",
    });
    mockDecideStageGate.mockResolvedValue({ transitioned: true, toStageKey: "tasks" });

    const res = await request(await createApp())
      .post("/api/approvals/approval-1/request-revision")
      .send({ decisionNote: "The migration has no down step." });

    expect(res.status).toBe(200);
    expect(mockDecideStageGate).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "request_changes",
        reason: "The migration has no down step.",
        decidedByUserId: "founder",
      }),
    );
  });

  it("a non-gate approval keeps its optional note — this rule is review-stage scoped", async () => {
    const hireApproval = { ...GATE_APPROVAL, type: "hire_agent", payload: {} };
    mockApprovalService.getById.mockResolvedValue(hireApproval);
    mockApprovalService.reject.mockResolvedValue({
      approval: { ...hireApproval, status: "rejected" },
      applied: true,
    });

    const res = await request(await createApp()).post("/api/approvals/approval-1/reject").send({});

    expect(res.status).toBe(200);
    expect(mockApprovalService.reject).toHaveBeenCalled();
    expect(mockDecideStageGate).not.toHaveBeenCalled();
  });
});
