import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
// ApexUnavailableError is imported dynamically inside each test (after
// vi.resetModules()) so the class reference used for `new X(...)` is the SAME
// module instance the brief assembler's `err instanceof X` checks against.

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

/** The real `design-change` flow, as `apex flows show design-change --output
 *  json` emits it — an A-node, the gate under review, then the merge
 *  workflow. "What happens next" must be derived from THIS, never hardcoded. */
const DESIGN_CHANGE_FLOW = {
  path: "/flows/design-change.yml",
  flow: {
    name: "design-change",
    version: "1.1",
    description:
      "A bounded agent step authors a design-board change and opens a .penpot pull request, a founder reviews it at a single gate, then the merge workflow lands it.",
    ticket_type: "design-change",
    nodes: [
      {
        id: "board_diff",
        kind: "agent",
        agent: { prompt_template: "do the thing", acceptance: "pr_exists:{{repo}}#{{head}}" },
        on_fail: "pause",
      },
      { id: "design_gate", kind: "gate", gate: { mode: "approve", prompt: "Review." }, on_fail: "pause" },
      {
        id: "merge",
        kind: "workflow",
        workflow: { workflow: "design-pr-merge", params: { repo: "sarala-ai/apex-design" } },
        on_fail: "pause",
      },
    ],
  },
};

async function createApp(options: {
  invoke: ReturnType<typeof vi.fn>;
  loadFlowDefinition?: ReturnType<typeof vi.fn>;
  provenanceLookup?: ReturnType<typeof vi.fn>;
  fetchDesignArchive?: ReturnType<typeof vi.fn>;
}) {
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
  app.use(
    "/api",
    approvalRoutes({} as any, {
      apexInvoker: { invoke: options.invoke } as any,
      loadFlowDefinition: (options.loadFlowDefinition ??
        vi.fn().mockResolvedValue(DESIGN_CHANGE_FLOW)) as any,
      // Default to "no archive readable" so the suite never shells out to gh;
      // the design-preview test injects a real fixture explicitly.
      fetchDesignArchive: (options.fetchDesignArchive ?? vi.fn().mockResolvedValue(null)) as any,
      provenanceLookup: (options.provenanceLookup ??
        vi.fn().mockResolvedValue({
          agentName: "Designer",
          permissionProfile: "bounded",
          permissionMode: "governed",
        })) as any,
    }),
  );
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
    issueTitle: "Board note: record the first governed design-change loop on Flows & gates",
    flowName: "design-change",
    nodeId: "design_gate",
    ticketType: "design-change",
    prompt: "Review the design-board diff (.penpot pull request).",
  },
};

/** Newest-first, exactly as activityService.forIssue returns it. */
const ACTIVITY_ROWS = [
  {
    action: "flow.gate_opened",
    createdAt: "2026-08-01T07:40:21.814Z",
    details: { nodeId: "design_gate", flowName: "design-change" },
  },
  {
    action: "flow.agent_step_succeeded",
    createdAt: "2026-08-01T07:40:20.528Z",
    details: {
      runId: "run-1",
      nodeId: "board_diff",
      acceptance: "pr_exists:sarala-ai/apex-design#design/APE-5",
      acceptanceEvaluation:
        "v1: run success + pr_exists verified (sarala-ai/apex-design#design/APE-5 → https://github.com/sarala-ai/apex-design/pull/2)",
    },
  },
  {
    action: "flow.agent_run_commissioned",
    createdAt: "2026-08-01T07:36:26.687Z",
    details: { runId: "run-1", agentId: "agent-1", nodeId: "board_diff" },
  },
];

const PR_SUCCESS = {
  status: "success",
  url: "https://github.com/sarala-ai/apex-design/pull/2",
  head_ref: "design/APE-5",
  title: "APE-5: Record first governed design-change loop",
  additions: 0,
  deletions: 0,
  changed_files: 1,
  files: [{ path: "product/apex-platform.penpot", status: "modified", additions: 0, deletions: 0 }],
  files_truncated: false,
};

describe("GET /approvals/:id/brief", () => {
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

  it("assembles the full brief: decision, plain-language verification, artifact, next steps, provenance", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);
    const invoke = vi.fn().mockImplementation(async () => structuredClone(PR_SUCCESS));

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);

    // 1 — what is being decided: plain language, no UUIDs in the headline.
    expect(res.body.decision.headline).toBe("Approve a design change");
    expect(res.body.decision.ticketIdentifier).toBe("APE-5");
    expect(res.body.decision.subject).toContain("Board note");
    expect(res.body.decision.detail).toBe(
      "1 file changed in sarala-ai/apex-design — product/apex-platform.penpot.",
    );
    expect(res.body.decision.headline).not.toMatch(/pr_exists|[0-9a-f]{8}-[0-9a-f]{4}/);

    // 2 — verification, translated. Machine strings are carried, not headlined.
    expect(res.body.verified.ok).toBe(true);
    expect(res.body.verified.headline).toBe(
      "Verified: the agent's run succeeded and the pull request it was required to open exists.",
    );
    expect(res.body.verified.headline).not.toContain("pr_exists:");
    expect(res.body.verified.machine).toContain("pr_exists:sarala-ai/apex-design#design/APE-5");

    // 3 — what to look at.
    expect(res.body.artifact).toMatchObject({
      available: true,
      degraded: false,
      url: "https://github.com/sarala-ai/apex-design/pull/2",
      files: [{ path: "product/apex-platform.penpot" }],
    });

    // 4 — what happens next, DERIVED from the flow's post-gate node.
    expect(res.body.next.derived).toBe(true);
    expect(res.body.next.approve).toContain("design-pr-merge");
    expect(res.body.next.approve).toContain("the flow completes");
    expect(res.body.next.reject).toContain("stops at this gate");
    expect(res.body.next.reject).toContain("stays open for you to handle");

    // 5 — who did the work.
    expect(res.body.provenance).toMatchObject({
      agentName: "Designer",
      agentId: "agent-1",
      runId: "run-1",
      permissionProfile: "bounded",
      commissionedAt: "2026-08-01T07:36:26.687Z",
      verifiedAt: "2026-08-01T07:40:20.528Z",
      gateOpenedAt: "2026-08-01T07:40:21.814Z",
    });

    // The artifact declares its KIND server-side, so the UI's renderer
    // registry never has to sniff file extensions of its own.
    expect(res.body.artifact.artifactKind).toBe("design");

    // Risk + reversibility, derived from the post-gate merge workflow.
    expect(res.body.risk).toMatchObject({ reversibility: "reversible", derived: true });
    expect(res.body.risk.reversibilityLine).toMatch(/revert/);

    // How long the founder has been the bottleneck.
    expect(res.body.waitingSince).toBe("2026-08-01T07:40:21.814Z");
  });

  it("carries per-file diff hunks and the binary flag through to the artifact", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);
    const invoke = vi.fn().mockResolvedValue({
      ...PR_SUCCESS,
      changed_files: 2,
      files: [
        {
          path: "server/src/a.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          binary: false,
          patch: "@@ -1 +1 @@\n-old\n+new",
          patch_truncated: false,
        },
        {
          path: "product/apex-platform.penpot",
          status: "modified",
          additions: 0,
          deletions: 0,
          binary: true,
          patch: null,
          patch_truncated: false,
        },
      ],
    });

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.artifact.files[0].patch).toContain("+new");
    expect(res.body.artifact.files[1].binary).toBe(true);
    // A .penpot in the changeset makes the whole thing a design review.
    expect(res.body.artifact.artifactKind).toBe("design");
  });

  it("attaches a real board preview to a design artifact, read from the PR's own .penpot", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const archive = readFileSync(
      fileURLToPath(new URL("../design/__fixtures__/apex-platform.penpot", import.meta.url)),
    );
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);
    const fetchDesignArchive = vi.fn().mockResolvedValue(archive);

    const res = await request(
      await createApp({ invoke: vi.fn().mockImplementation(async () => structuredClone(PR_SUCCESS)), fetchDesignArchive }),
    ).get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    const file = res.body.artifact.files[0];
    expect(file.design.boards.length).toBe(11);
    expect(file.design.preview.dataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(fetchDesignArchive).toHaveBeenCalledWith(
      "sarala-ai/apex-design",
      "product/apex-platform.penpot",
      "design/APE-5",
    );
  });

  it("omits the design block entirely when the archive is unreadable — never a fake preview", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);

    const res = await request(
      await createApp({ invoke: vi.fn().mockImplementation(async () => structuredClone(PR_SUCCESS)) }),
    ).get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.artifact.artifactKind).toBe("design");
    expect(res.body.artifact.files[0].design ?? null).toBeNull();
  });

  it("classifies a pure code changeset as code and marks a deploy as going live", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);
    const loadFlowDefinition = vi.fn().mockResolvedValue({
      path: "/flows/bug.yml",
      flow: {
        ...DESIGN_CHANGE_FLOW.flow,
        nodes: [
          DESIGN_CHANGE_FLOW.flow.nodes[1],
          { id: "deploy", kind: "workflow", workflow: { workflow: "cloud_run_deploy", params: {} }, on_fail: "pause" },
        ],
      },
    });
    const invoke = vi.fn().mockResolvedValue({
      ...PR_SUCCESS,
      files: [{ path: "server/src/a.ts", status: "modified", additions: 2, deletions: 1, patch: "@@\n+x" }],
    });

    const res = await request(await createApp({ invoke, loadFlowDefinition }))
      .get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.artifact.artifactKind).toBe("code");
    expect(res.body.risk.reversibility).toBe("reversible_with_effort");
    expect(res.body.risk.risks.join(" ")).toContain("cloud_run_deploy");
  });

  it("derives a different next-step sentence when the flow's post-gate node changes", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);
    const loadFlowDefinition = vi.fn().mockResolvedValue({
      path: "/flows/design-change.yml",
      flow: {
        ...DESIGN_CHANGE_FLOW.flow,
        nodes: [
          DESIGN_CHANGE_FLOW.flow.nodes[0],
          DESIGN_CHANGE_FLOW.flow.nodes[1],
          { id: "lint", kind: "check", check: { tool: "penpot-lint", args: [], pass_criteria: "ok" }, on_fail: "pause" },
          DESIGN_CHANGE_FLOW.flow.nodes[2],
        ],
      },
    });

    const res = await request(await createApp({ invoke: vi.fn().mockImplementation(async () => structuredClone(PR_SUCCESS)), loadFlowDefinition }))
      .get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.next.derived).toBe(true);
    expect(res.body.next.approve).toContain("penpot-lint");
    expect(res.body.next.approve).toContain("1 more step");
    expect(res.body.next.approve).not.toContain("design-pr-merge");
  });

  it("falls back to a generic next-step sentence when the flow definition cannot be loaded", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);
    const { ApexUnavailableError } = await import("../apex/invoke.js");
    const loadFlowDefinition = vi
      .fn()
      .mockRejectedValue(new ApexUnavailableError("apex CLI not found (bin: apex)"));

    const res = await request(await createApp({ invoke: vi.fn().mockImplementation(async () => structuredClone(PR_SUCCESS)), loadFlowDefinition }))
      .get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.next.derived).toBe(false);
    expect(res.body.next.note).toContain("apex CLI not found");
    // The rest of the brief still stands.
    expect(res.body.verified.ok).toBe(true);
    expect(res.body.artifact.degraded).toBe(false);
  });

  it("degrades the artifact section (never 500) when the PR fetch fails", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);
    const { ApexInvocationError } = await import("../apex/invoke.js");
    const invoke = vi.fn().mockRejectedValue(new ApexInvocationError("gh exited 1"));

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.artifact).toMatchObject({
      available: true,
      degraded: true,
      repo: "sarala-ai/apex-design",
      headBranch: "design/APE-5",
      error: "gh exited 1",
    });
    // The acceptance was still recorded, so verification is still answerable.
    expect(res.body.verified.ok).toBe(true);
    expect(res.body.decision.detail).toContain("A pull request on sarala-ai/apex-design");
  });

  it("still answers the decision when no acceptance declaration exists", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue([
      { action: "flow.gate_opened", createdAt: "2026-08-01T07:40:21.814Z", details: {} },
    ]);
    const invoke = vi.fn();

    const res = await request(await createApp({ invoke })).get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(res.body.artifact).toEqual({
      available: false,
      reason: "no pr_exists acceptance found for this issue",
    });
    expect(res.body.verified.ok).toBeNull();
    expect(res.body.verified.headline).toContain("No automatic check was recorded");
    expect(res.body.next.derived).toBe(true);
    expect(res.body.next.approve).toContain("design-pr-merge");
  });

  it("reports a failed acceptance in plain language", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue([
      {
        action: "flow.paused",
        createdAt: "2026-08-01T07:32:18.355Z",
        details: {
          acceptance: "pr_exists:sarala-ai/apex-design#design/APE-5",
          acceptanceEvaluation: "v1: run success + pr_exists check FAILED (sarala-ai/apex-design#design/APE-5)",
        },
      },
    ]);

    const res = await request(await createApp({ invoke: vi.fn().mockImplementation(async () => structuredClone(PR_SUCCESS)) })).get(
      "/api/approvals/approval-1/brief",
    );

    expect(res.status).toBe(200);
    expect(res.body.verified.ok).toBe(false);
    expect(res.body.verified.headline).toContain("did NOT pass");
    expect(res.body.verified.headline).not.toContain("pr_exists:");
  });

  it("keeps the brief usable when the provenance lookup throws", async () => {
    mockApprovalService.getById.mockResolvedValue(FLOW_GATE_APPROVAL);
    mockActivityService.forIssue.mockResolvedValue(ACTIVITY_ROWS);
    const provenanceLookup = vi.fn().mockRejectedValue(new Error("db down"));

    const res = await request(
      await createApp({ invoke: vi.fn().mockImplementation(async () => structuredClone(PR_SUCCESS)), provenanceLookup }),
    ).get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.provenance.agentName).toBeNull();
    expect(res.body.provenance.agentId).toBe("agent-1");
  });

  it("reports not-applicable for non-flow_gate approval types", async () => {
    mockApprovalService.getById.mockResolvedValue({ ...FLOW_GATE_APPROVAL, type: "hire_agent" });

    const res = await request(await createApp({ invoke: vi.fn() })).get("/api/approvals/approval-1/brief");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false, reason: "not_a_flow_gate_approval" });
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing approval and 403 across companies", async () => {
    mockApprovalService.getById.mockResolvedValue(null);
    expect(
      (await request(await createApp({ invoke: vi.fn() })).get("/api/approvals/missing/brief")).status,
    ).toBe(404);

    mockApprovalService.getById.mockResolvedValue({ ...FLOW_GATE_APPROVAL, companyId: "company-2" });
    expect(
      (await request(await createApp({ invoke: vi.fn() })).get("/api/approvals/approval-1/brief")).status,
    ).toBe(403);
  });
});
