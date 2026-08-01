import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { companyRoutes } from "../routes/companies.js";

// GET /api/companies/identity-preview — read-only preview of the issue
// prefix + slug companyService.create() would allocate for ?name=, used by
// the onboarding wizard's identity step. Same authorization gate as company
// creation itself (instance admin / local_implicit board actor only).

const mockIdentityPreview = vi.fn();

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    identityPreview: mockIdentityPreview,
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  companyArtifactsService: () => ({ list: vi.fn() }),
  accessService: () => ({ canUser: vi.fn(), ensureMembership: vi.fn(), ensureRoleDefaultGrants: vi.fn() }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

function buildApp(actor: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message, details: err.details });
  });
  return app;
}

const localImplicitActor = { type: "board", source: "local_implicit" };
const instanceAdminActor = { type: "board", source: "cloud", isInstanceAdmin: true };
const nonAdminBoardActor = { type: "board", source: "cloud", isInstanceAdmin: false, companyIds: [] };
const agentActor = { type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" };

const previewResult = {
  name: "Acme",
  issuePrefix: "ACM",
  slug: "acm",
  prefixAvailable: true,
  slugAvailable: true,
  suggestedPrefix: null,
  suggestedSlug: null,
};

describe("GET /api/companies/identity-preview", () => {
  it("returns the preview for a local_implicit board actor", async () => {
    mockIdentityPreview.mockReset().mockResolvedValue(previewResult);

    const res = await request(buildApp(localImplicitActor)).get("/api/companies/identity-preview?name=Acme");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(previewResult);
    expect(mockIdentityPreview).toHaveBeenCalledWith("Acme", { issuePrefix: undefined, slug: undefined });
  });

  it("returns the preview for an instance-admin board actor", async () => {
    mockIdentityPreview.mockReset().mockResolvedValue(previewResult);

    const res = await request(buildApp(instanceAdminActor)).get("/api/companies/identity-preview?name=Acme");

    expect(res.status).toBe(200);
    expect(mockIdentityPreview).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-instance-admin board actor with 403, without calling the service", async () => {
    mockIdentityPreview.mockReset();

    const res = await request(buildApp(nonAdminBoardActor)).get("/api/companies/identity-preview?name=Acme");

    expect(res.status).toBe(403);
    expect(mockIdentityPreview).not.toHaveBeenCalled();
  });

  it("rejects an agent actor with 403 (board access required), without calling the service", async () => {
    mockIdentityPreview.mockReset();

    const res = await request(buildApp(agentActor)).get("/api/companies/identity-preview?name=Acme");

    expect(res.status).toBe(403);
    expect(mockIdentityPreview).not.toHaveBeenCalled();
  });

  it("forwards a well-formed prefix/slug override to the service", async () => {
    mockIdentityPreview.mockReset().mockResolvedValue(previewResult);

    const res = await request(buildApp(instanceAdminActor)).get(
      "/api/companies/identity-preview?name=Acme&prefix=custom&slug=Custom-Slug",
    );

    expect(res.status).toBe(200);
    // companyIssuePrefixSchema uppercases, companySlugSchema lowercases —
    // both transforms run before the service ever sees the override.
    expect(mockIdentityPreview).toHaveBeenCalledWith("Acme", { issuePrefix: "CUSTOM", slug: "custom-slug" });
  });

  it("falls back to the derived default when an override is malformed rather than erroring", async () => {
    mockIdentityPreview.mockReset().mockResolvedValue(previewResult);

    const res = await request(buildApp(instanceAdminActor)).get(
      "/api/companies/identity-preview?name=Acme&prefix=1nvalid&slug=Not A Slug!",
    );

    expect(res.status).toBe(200);
    expect(mockIdentityPreview).toHaveBeenCalledWith("Acme", { issuePrefix: undefined, slug: undefined });
  });

  it("treats a missing name as an empty string rather than throwing", async () => {
    mockIdentityPreview.mockReset().mockResolvedValue({
      name: "",
      issuePrefix: "",
      slug: "",
      prefixAvailable: false,
      slugAvailable: false,
      suggestedPrefix: null,
      suggestedSlug: null,
    });

    const res = await request(buildApp(instanceAdminActor)).get("/api/companies/identity-preview");

    expect(res.status).toBe(200);
    expect(mockIdentityPreview).toHaveBeenCalledWith("", { issuePrefix: undefined, slug: undefined });
  });
});
