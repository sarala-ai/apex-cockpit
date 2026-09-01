import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
// ApexUnavailableError/ApexInvocationError are imported dynamically inside
// each test (after vi.resetModules()) so the class reference used for
// `new X(...)` is the SAME module instance approvals.ts's `err instanceof X`
// checks against — a static top-level import here would bind to a stale
// module instance once resetModules clears the registry.

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({
  forIssue: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    activityService: () => mockActivityService,
    heartbeatService: () => ({ wakeup: vi.fn() }),
    issueApprovalService: () => ({ listIssuesForApproval: vi.fn(), linkManyForApproval: vi.fn() }),
    logActivity: vi.fn(),
    secretService: () => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }),
  }));
}

async function createApp(apexInvoker: { invoke: ReturnType<typeof vi.fn> }) {
  const [{ errorHandler }, { approvalRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/approvals.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  // db is unused directly by the route besides passing to activityService(db),
  // which is mocked above, so an empty stub is sufficient.
  app.use("/api", approvalRoutes({} as any, { apexInvoker: apexInvoker as any }));
  app.use(errorHandler);
  return app;
}

const FLOW_GATE_APPROVAL = {
  id: "approval-1",
  companyId: "company-1",
  type: "flow_gate",
  status: "pending",
  payload: {
    issueId: "issue-1",
    issueIdentifier: "APE-5",
    flowName: "design-change-flow",
    nodeId: "gate-review",
    prompt: "Review before merging.",
  },
};

const PR_ACCEPTANCE_ROW = {
  details: {
    acceptance: "pr_exists:sarala-ai/apex-design#design/APE-5",
    acceptanceEvaluation: "v1: run success + pr_exists verified (sarala-ai/apex-design#design/APE-5)",
  },
};

describe("GET /approvals/:id/pr-diff", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/approvals.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
  });

  it("returns the PR diff summary on success", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue([PR_ACCEPTANCE_ROW]);
    const invoke = vi.fn().mockResolvedValue({
      status: "success",
      url: "https://github.com/sarala-ai/apex-design/pull/2",
      head_ref: "design/APE-5",
      title: "APE-5: Record first governed design-change loop",
      additions: 8,
      deletions: 2,
      changed_files: 1,
      files: [{ path: "product/apex-platform.penpot", status: "modified", additions: 8, deletions: 2 }],
      files_truncated: false,
    });

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/pr-diff");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: true,
      degraded: false,
      repo: "sarala-ai/apex-design",
      headBranch: "design/APE-5",
      url: "https://github.com/sarala-ai/apex-design/pull/2",
      title: "APE-5: Record first governed design-change loop",
      totals: { additions: 8, deletions: 2, changedFiles: 1 },
      files: [{ path: "product/apex-platform.penpot", status: "modified", additions: 8, deletions: 2 }],
      files_truncated: false,
      acceptanceEvaluation: "v1: run success + pr_exists verified (sarala-ai/apex-design#design/APE-5)",
    });
    expect(invoke).toHaveBeenCalledWith(
      "github_repo",
      "get_pull_request",
      { repo: "sarala-ai/apex-design", head: "design/APE-5" },
      expect.anything(),
    );
  });

  it("degrades gracefully (never 500) when apex CLI is unavailable", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue([PR_ACCEPTANCE_ROW]);
    const { ApexUnavailableError } = await import("../apex/invoke.js");
    const invoke = vi.fn().mockRejectedValue(new ApexUnavailableError("apex CLI not found (bin: apex)"));

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/pr-diff");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: true,
      degraded: true,
      repo: "sarala-ai/apex-design",
      headBranch: "design/APE-5",
      error: "apex CLI not found (bin: apex)",
    });
  });

  it("degrades gracefully when the gh/apex invocation fails", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue([PR_ACCEPTANCE_ROW]);
    const { ApexInvocationError } = await import("../apex/invoke.js");
    const invoke = vi.fn().mockRejectedValue(new ApexInvocationError("apex run github_repo get_pull_request failed"));

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/pr-diff");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.degraded).toBe(true);
    expect(res.body.error).toContain("apex run github_repo get_pull_request failed");
  });

  it("reports not-applicable when no pr_exists acceptance exists on the issue", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue([]);
    const invoke = vi.fn();

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/pr-diff");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, reason: "no pr_exists acceptance found for this issue" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports not-applicable for non-flow_gate approval types", async () => {
    mockApprovalService.getById.mockResolvedValue({
      ...FLOW_GATE_APPROVAL,
      type: "hire_agent",
    });
    const invoke = vi.fn();

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/pr-diff");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, reason: "not_a_flow_gate_approval" });
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns 404 when the approval does not exist", async () => {
    mockApprovalService.getById.mockResolvedValue(null);
    const invoke = vi.fn();

    const res = await request(await createApp({ invoke })).get("/api/approvals/missing/pr-diff");

    expect(res.status).toBe(404);
  });

  it("rejects cross-company access", async () => {
    mockApprovalService.getById.mockResolvedValue({ ...FLOW_GATE_APPROVAL, companyId: "company-2" });
    const invoke = vi.fn();

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/pr-diff");

    expect(res.status).toBe(403);
    expect(invoke).not.toHaveBeenCalled();
  });
});
