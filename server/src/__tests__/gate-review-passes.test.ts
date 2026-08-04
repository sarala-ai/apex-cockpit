/**
 * Review passes at a flow gate — the questions the gate asks, and the record
 * of which ones the approver ticked.
 *
 * Two halves, matching the two claims worth testing:
 *   1. the brief carries the gate's declared passes with their apex-core
 *      question text, and carries NOTHING when the gate declares none;
 *   2. approving/rejecting records the ticked ids on the decision's activity
 *      entry — and records nothing when nothing was ticked (an empty list
 *      must not read as "reviewed, found nothing").
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assembleFlowGateBrief, collectReviewPasses } from "../apex/steps/brief.js";
import type { ProcessDefinition } from "../apex/steps/process-definition.js";
import type { ReviewPass } from "../apex/steps/review-passes.js";

const CATALOG: Record<string, ReviewPass> = {
  customer_hat: {
    id: "customer_hat",
    label: "Customer hat",
    persona: "the person who sees this",
    question: "Would a first-time user understand this screen without knowing how it was built?",
  },
  cognitive_load: {
    id: "cognitive_load",
    label: "Cognitive load",
    persona: "the reader making the decision",
    question: "Does this remove noise without hiding consequences?",
  },
};

function flowWithGate(requires: string[] | undefined): ProcessDefinition {
  return {
    name: "design-change",
    version: "1.1",
    description: "d",
    ticket_type: "design-change",
    steps: [
      {
        id: "design_gate",
        kind: "gate",
        gate: { mode: "approve", prompt: "Review.", ...(requires ? { requires } : {}) },
        on_fail: "pause",
      },
      {
        id: "merge",
        kind: "run",
        run: { target: { type: "workflow", workflow: "design-pr-merge", params: {} } },
        on_fail: "pause",
      },
    ],
  } as unknown as ProcessDefinition;
}

describe("collectReviewPasses", () => {
  it("returns the gate's declared passes, in the declared order, with core's question text", () => {
    const items = collectReviewPasses(
      flowWithGate(["cognitive_load", "customer_hat"]),
      "design_gate",
      CATALOG,
    );
    expect(items.map((i) => i.id)).toEqual(["cognitive_load", "customer_hat"]);
    expect(items[0]).toEqual({
      id: "cognitive_load",
      label: "Cognitive load",
      question: "Does this remove noise without hiding consequences?",
    });
  });

  it("returns nothing when the gate declares no passes", () => {
    expect(collectReviewPasses(flowWithGate([]), "design_gate", CATALOG)).toEqual([]);
    expect(collectReviewPasses(flowWithGate(undefined), "design_gate", CATALOG)).toEqual([]);
  });

  it("returns nothing when the flow definition or the gate id is unavailable", () => {
    expect(collectReviewPasses(null, "design_gate", CATALOG)).toEqual([]);
    expect(collectReviewPasses(flowWithGate(["customer_hat"]), null, CATALOG)).toEqual([]);
    expect(collectReviewPasses(flowWithGate(["customer_hat"]), "not_a_node", CATALOG)).toEqual([]);
  });

  it("skips ids the catalog does not carry rather than inventing question text", () => {
    const items = collectReviewPasses(
      flowWithGate(["customer_hat", "pass_from_a_newer_core"]),
      "design_gate",
      CATALOG,
    );
    expect(items.map((i) => i.id)).toEqual(["customer_hat"]);
  });
});

describe("assembleFlowGateBrief carries the gate's passes", () => {
  const baseInput = {
    approvalId: "approval-1",
    payload: { issueId: "issue-1", flowName: "design-change", nodeId: "design_gate" },
    activityRows: [],
    apexInvoker: { invoke: vi.fn() } as any,
  };

  it("surfaces the passes with their questions", async () => {
    const brief = await assembleFlowGateBrief({
      ...baseInput,
      loadProcessDefinition: async () => flowWithGate(["customer_hat"]),
    });
    expect(brief.available).toBe(true);
    if (!brief.available) return;
    expect(brief.reviewPasses).toEqual([
      {
        id: "customer_hat",
        label: "Customer hat",
        question: "Would a first-time user understand this screen without knowing how it was built?",
      },
    ]);
  });

  it("degrades to an empty list when the process definition is unavailable", async () => {
    const brief = await assembleFlowGateBrief({
      ...baseInput,
      loadProcessDefinition: async () => {
        throw new Error("the database is unreachable");
      },
    });
    expect(brief.available).toBe(true);
    if (!brief.available) return;
    expect(brief.reviewPasses).toEqual([]);
    expect(brief.next.note).toContain("process definition unavailable");
  });
});

// ---------------------------------------------------------------------------
// The decision record
// ---------------------------------------------------------------------------

const mockApprovalService = vi.hoisted(() => ({
  getById: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({ decide: vi.fn() }));
const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
  linkManyForApproval: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    activityService: () => ({ forIssue: vi.fn() }),
    heartbeatService: () => ({ wakeup: vi.fn() }),
    issueApprovalService: () => mockIssueApprovalService,
    logActivity: mockLogActivity,
    secretService: () => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() }),
  }));
}

const APPROVAL = {
  id: "approval-1",
  companyId: "company-1",
  type: "request_board_approval",
  status: "pending",
  requestedByAgentId: null,
  payload: {},
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
      userId: "user-1",
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

function decisionDetails(action: string): Record<string, unknown> | undefined {
  const call = mockLogActivity.mock.calls.find((c) => (c[1] as any)?.action === action);
  return (call?.[1] as any)?.details;
}

describe("acknowledged review passes on the decision record", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockApprovalService.getById.mockResolvedValue(APPROVAL);
    mockApprovalService.approve.mockResolvedValue({
      approval: { ...APPROVAL, status: "approved" },
      applied: true,
    });
    mockApprovalService.reject.mockResolvedValue({
      approval: { ...APPROVAL, status: "rejected" },
      applied: true,
    });
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([]);
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("records the ticked passes with an approval", async () => {
    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({ acknowledgedReviewPasses: ["customer_hat", "cognitive_load"] });
    expect(res.status).toBe(200);
    expect(decisionDetails("approval.approved")).toMatchObject({
      acknowledgedReviewPasses: ["customer_hat", "cognitive_load"],
    });
  });

  it("records the ticked passes with a rejection", async () => {
    const res = await request(await createApp())
      .post("/api/approvals/approval-1/reject")
      .send({ acknowledgedReviewPasses: ["customer_hat"] });
    expect(res.status).toBe(200);
    expect(decisionDetails("approval.rejected")).toMatchObject({
      acknowledgedReviewPasses: ["customer_hat"],
    });
  });

  it("records no key at all when nothing was ticked", async () => {
    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({ acknowledgedReviewPasses: [] });
    expect(res.status).toBe(200);
    expect(decisionDetails("approval.approved")).not.toHaveProperty("acknowledgedReviewPasses");
  });

  it("approves normally when the field is absent — ticking is never a precondition", async () => {
    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({});
    expect(res.status).toBe(200);
    expect(mockApprovalService.approve).toHaveBeenCalled();
    expect(decisionDetails("approval.approved")).not.toHaveProperty("acknowledgedReviewPasses");
  });

  it("rejects a malformed acknowledgement list rather than storing garbage", async () => {
    const res = await request(await createApp())
      .post("/api/approvals/approval-1/approve")
      .send({ acknowledgedReviewPasses: "customer_hat" });
    expect(res.status).toBe(400);
  });
});
