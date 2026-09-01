import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
  breakGlassChangeSlug: vi.fn(),
  breakGlassChangeIssuePrefix: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockCompanyArtifactsService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyArtifactsService: () => mockCompanyArtifactsService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

function createCompany() {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    slug: "pap",
    issueCounter: 568,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    brandColor: "#123456",
    logoAssetId: "11111111-1111-4111-8111-111111111111",
    logoUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content",
    createdAt: now,
    updatedAt: now,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/companies/:companyId/branding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("rejects non-CEO agent callers", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ logoAssetId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects non-CEO agent callers before validating branding body shape", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ status: "archived" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows CEO agent callers to update branding fields", async () => {
    const company = createCompany();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    mockCompanyService.update.mockResolvedValue(company);
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        brandColor: "#123456",
      });

    expect(res.status).toBe(200);
    expect(res.body.logoAssetId).toBe(company.logoAssetId);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", {
      logoAssetId: "11111111-1111-4111-8111-111111111111",
      brandColor: "#123456",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "company.branding_updated",
        details: {
          logoAssetId: "11111111-1111-4111-8111-111111111111",
          brandColor: "#123456",
        },
      }),
    );
  });

  it("allows board callers to update branding fields", async () => {
    const company = createCompany();
    mockCompanyService.update.mockResolvedValue({
      ...company,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ brandColor: null, logoAssetId: null });

    expect(res.status).toBe(200);
    expect(res.body.brandColor ?? null).toBeNull();
    expect(res.body.logoAssetId ?? null).toBeNull();
  });

  it("rejects non-branding fields in the request body", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/companies/:companyId", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("rejects non-CEO agent callers before loading the company or validating settings body shape", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ status: "archived" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyService.getById).not.toHaveBeenCalled();
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows CEO agent callers to update only branding fields through the general settings route", async () => {
    const company = createCompany();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    mockCompanyService.getById.mockResolvedValue(company);
    mockCompanyService.update.mockResolvedValue({
      ...company,
      name: "New Name",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ name: "New Name" });

    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", { name: "New Name" }, expect.objectContaining({
      actorType: "agent",
      actorId: "agent-1",
    }));
  });

  it("rejects CEO agent attempts to update lifecycle, budget, consent, or prefix fields", async () => {
    const company = createCompany();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    mockCompanyService.getById.mockResolvedValue(company);
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({
        status: "archived",
        budgetMonthlyCents: 1000,
        spentMonthlyCents: 500,
        requireBoardApprovalForNewAgents: true,
        feedbackDataSharingEnabled: true,
        issuePrefix: "BAD",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("keeps full company settings updates board-only", async () => {
    const company = createCompany();
    mockCompanyService.getById.mockResolvedValue(company);
    mockCompanyService.update.mockResolvedValue({
      ...company,
      status: "paused",
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ status: "paused" });

    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", { status: "paused" }, expect.objectContaining({
      actorType: "user",
      actorId: "user-1",
    }));
  });

  it("rejects a malformed slug before reaching the service", async () => {
    const company = createCompany();
    mockCompanyService.getById.mockResolvedValue(company);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ slug: "Not Valid!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("normalizes an uppercase-but-otherwise-valid slug to lowercase before it reaches the service", async () => {
    const company = { ...createCompany(), slug: null };
    mockCompanyService.getById.mockResolvedValue(company);
    mockCompanyService.update.mockResolvedValue({ ...company, slug: "acme" });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ slug: "ACME" });

    expect(res.status).toBe(200);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", { slug: "acme" }, expect.objectContaining({
      actorType: "user",
      actorId: "user-1",
    }));
  });

  it("surfaces the service's classified 409 when the slug is already set", async () => {
    const company = createCompany(); // slug: "pap" (already set)
    mockCompanyService.getById.mockResolvedValue(company);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });
    // Import from the same module registry snapshot createApp() just populated,
    // so this HttpError and the errorHandler's `instanceof HttpError` check
    // share one class identity (vi.resetModules() in beforeEach would otherwise
    // make them distinct realms).
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockCompanyService.update.mockRejectedValue(
      new HttpError(409, "Company slug is permanent and cannot be changed once set.", { code: "slug_immutable" }),
    );

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ slug: "new-slug" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("slug_immutable");
  });

  it("surfaces the service's classified 409 when the slug is already taken by another company", async () => {
    const company = { ...createCompany(), slug: null };
    mockCompanyService.getById.mockResolvedValue(company);
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockCompanyService.update.mockRejectedValue(
      new HttpError(409, 'Slug "taken" is already in use by another company.', { code: "slug_conflict" }),
    );

    const res = await request(app)
      .patch("/api/companies/company-1")
      .send({ slug: "taken" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("slug_conflict");
  });
});

describe("POST /api/companies/:companyId/slug-break-glass", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  function consequences(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      companyId: "company-1",
      currentSlug: "pap",
      proposedSlug: "new-alias",
      envVarsThatChange: [{ kind: "env_var", current: "APEX_PAP_WORKFLOWS_PATH", next: "APEX_NEW-ALIAS_WORKFLOWS_PATH", note: "n/a" }],
      capabilitySyncTargets: [],
      boundRepoConfigs: [],
      warning: "test warning",
      ...overrides,
    };
  }

  it("rejects agent callers outright (board/instance-admin only)", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/slug-break-glass")
      .send({ newSlug: "new-alias" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.breakGlassChangeSlug).not.toHaveBeenCalled();
  });

  it("rejects board callers who are not instance admins", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/slug-break-glass")
      .send({ newSlug: "new-alias" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.breakGlassChangeSlug).not.toHaveBeenCalled();
  });

  it("rejects a malformed newSlug before reaching the service", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/slug-break-glass")
      .send({ newSlug: "Not Valid!" });

    expect(res.status).toBe(400);
    expect(mockCompanyService.breakGlassChangeSlug).not.toHaveBeenCalled();
  });

  it("returns a preview (200) when confirm is omitted, without executing", async () => {
    mockCompanyService.breakGlassChangeSlug.mockResolvedValue({
      preview: true,
      consequences: consequences(),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/slug-break-glass")
      .send({ newSlug: "new-alias" });

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.consequences.proposedSlug).toBe("new-alias");
    expect(mockCompanyService.breakGlassChangeSlug).toHaveBeenCalledWith(
      "company-1",
      "new-alias",
      expect.objectContaining({ confirm: undefined }),
    );
  });

  it("executes the change and returns the company + activity id when confirm is provided", async () => {
    mockCompanyService.breakGlassChangeSlug.mockResolvedValue({
      preview: false,
      company: { ...createCompany(), slug: "new-alias" },
      consequences: consequences(),
      activityId: "activity-123",
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/slug-break-glass")
      .send({ newSlug: "new-alias", confirm: "pap" });

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(false);
    expect(res.body.company.slug).toBe("new-alias");
    expect(res.body.activityId).toBe("activity-123");
    expect(mockCompanyService.breakGlassChangeSlug).toHaveBeenCalledWith(
      "company-1",
      "new-alias",
      expect.objectContaining({ confirm: "pap" }),
    );
  });

  it("surfaces the service's classified 409 on confirm mismatch", async () => {
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockCompanyService.breakGlassChangeSlug.mockRejectedValue(
      new HttpError(409, "Break-glass slug change requires typing the CURRENT slug.", {
        code: "slug_break_glass_confirm_mismatch",
      }),
    );
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/slug-break-glass")
      .send({ newSlug: "new-alias", confirm: "wrong" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("slug_break_glass_confirm_mismatch");
  });
});

describe("POST /api/companies/:companyId/issue-prefix-break-glass", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  function consequences(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      companyId: "company-1",
      currentPrefix: "PAP",
      proposedPrefix: "NEWP",
      existingIssueCount: 3,
      sampleRewrittenIdentifiers: [{ current: "PAP-3", next: "NEWP-3" }],
      githubProjectionRepo: null,
      warning: "test warning",
      ...overrides,
    };
  }

  it("rejects agent callers outright (board/instance-admin only)", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issue-prefix-break-glass")
      .send({ newPrefix: "NEWP" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.breakGlassChangeIssuePrefix).not.toHaveBeenCalled();
  });

  it("rejects board callers who are not instance admins", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/issue-prefix-break-glass")
      .send({ newPrefix: "NEWP" });

    expect(res.status).toBe(403);
    expect(mockCompanyService.breakGlassChangeIssuePrefix).not.toHaveBeenCalled();
  });

  it("rejects a malformed newPrefix before reaching the service", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issue-prefix-break-glass")
      .send({ newPrefix: "not valid!" });

    expect(res.status).toBe(400);
    expect(mockCompanyService.breakGlassChangeIssuePrefix).not.toHaveBeenCalled();
  });

  it("returns a preview (200) when confirm is omitted, without executing", async () => {
    mockCompanyService.breakGlassChangeIssuePrefix.mockResolvedValue({
      preview: true,
      consequences: consequences(),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issue-prefix-break-glass")
      .send({ newPrefix: "NEWP" });

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.consequences.proposedPrefix).toBe("NEWP");
    expect(mockCompanyService.breakGlassChangeIssuePrefix).toHaveBeenCalledWith(
      "company-1",
      "NEWP",
      expect.objectContaining({ confirm: undefined }),
    );
  });

  it("executes the change and returns the company + activity id when confirm is provided", async () => {
    mockCompanyService.breakGlassChangeIssuePrefix.mockResolvedValue({
      preview: false,
      company: { ...createCompany(), issuePrefix: "NEWP" },
      consequences: consequences(),
      activityId: "activity-456",
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issue-prefix-break-glass")
      .send({ newPrefix: "NEWP", confirm: "PAP" });

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(false);
    expect(res.body.company.issuePrefix).toBe("NEWP");
    expect(res.body.activityId).toBe("activity-456");
    expect(mockCompanyService.breakGlassChangeIssuePrefix).toHaveBeenCalledWith(
      "company-1",
      "NEWP",
      expect.objectContaining({ confirm: "PAP" }),
    );
  });

  it("surfaces the service's classified 409 on confirm mismatch", async () => {
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockCompanyService.breakGlassChangeIssuePrefix.mockRejectedValue(
      new HttpError(409, "Break-glass issue prefix change requires typing the CURRENT prefix.", {
        code: "issue_prefix_break_glass_confirm_mismatch",
      }),
    );
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/companies/company-1/issue-prefix-break-glass")
      .send({ newPrefix: "NEWP", confirm: "wrong" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("issue_prefix_break_glass_confirm_mismatch");
  });
});
