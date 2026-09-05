import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const mockComputeOrgFacts = vi.hoisted(() => vi.fn());
const mockSurfaceFlagsService = vi.hoisted(() => ({
  list: vi.fn(),
  set: vi.fn(),
  reconcile: vi.fn(),
}));
const mockUiPreferenceService = vi.hoisted(() => ({
  getForUser: vi.fn(),
}));

vi.mock("../services/org-facts.js", () => ({
  computeOrgFacts: mockComputeOrgFacts,
}));
vi.mock("../services/surface-flags.js", () => ({
  surfaceFlagsService: () => mockSurfaceFlagsService,
}));
vi.mock("../services/ui-preferences.js", () => ({
  uiPreferenceService: () => mockUiPreferenceService,
}));

const FACTS = {
  asOf: "2026-01-01T00:00:00.000Z",
  hasRepoOrCloudBinding: false,
  runsStarted: 0,
  runsCompleted: 0,
  firstRunAt: null,
  liveRunCount: 0,
  openPrCount: 0,
  deploysLanded: 0,
  gatewayCallAudited: false,
  orgMemberCount: 0,
  companyMemberCount: 0,
  goalCount: 0,
  operatorAuthHealthy: false,
};

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};

async function createApp(actor: Record<string, unknown> = BOARD_ACTOR) {
  const [{ surfaceFlagRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/surface-flags.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use(surfaceFlagRoutes({} as unknown as Db));
  app.use(errorHandler);
  return app;
}

describe("surface-flags routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComputeOrgFacts.mockResolvedValue(FACTS);
    mockUiPreferenceService.getForUser.mockResolvedValue({ theme: null, showAllSurfaces: false, updatedAt: null });
  });

  describe("GET /orgs/:orgId/surfaces", () => {
    it("merges the registry list with facts and the user's showAllSurfaces preference", async () => {
      mockSurfaceFlagsService.list.mockResolvedValue([{ key: "dashboard", visible: true }]);
      const res = await request(await createApp()).get("/orgs/org-1/surfaces");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ surfaces: [{ key: "dashboard", visible: true }], facts: FACTS });
      expect(mockComputeOrgFacts).toHaveBeenCalledWith({}, { orgId: "org-1", userId: "user-1" });
      expect(mockSurfaceFlagsService.list).toHaveBeenCalledWith("org-1", FACTS, false);
    });

    it("rejects a caller with no board org access", async () => {
      const res = await request(await createApp({ type: "agent", agentId: "a1", source: "agent_key" })).get(
        "/orgs/org-1/surfaces",
      );
      expect(res.status).toBe(403);
      expect(mockSurfaceFlagsService.list).not.toHaveBeenCalled();
    });
  });

  describe("PUT /orgs/:orgId/surfaces/:surfaceKey", () => {
    it("defaults source to api with no UI header", async () => {
      mockSurfaceFlagsService.set.mockResolvedValue({ surfaceKey: "tasks", unveiled: true, source: "api" });
      const res = await request(await createApp())
        .put("/orgs/org-1/surfaces/tasks")
        .send({ unveiled: true, reason: "manual override" });
      expect(res.status).toBe(200);
      expect(mockSurfaceFlagsService.set).toHaveBeenCalledWith("org-1", "tasks", {
        unveiled: true,
        reason: "manual override",
        source: "api",
        actorUserId: "user-1",
        actorRunId: null,
      });
    });

    it("resolves source to user when X-Paperclip-Ui: 1 is set", async () => {
      mockSurfaceFlagsService.set.mockResolvedValue({ surfaceKey: "tasks", unveiled: true, source: "user" });
      const res = await request(await createApp())
        .put("/orgs/org-1/surfaces/tasks")
        .set("X-Paperclip-Ui", "1")
        .send({ unveiled: true, reason: "operator clicked unveil" });
      expect(res.status).toBe(200);
      expect(mockSurfaceFlagsService.set).toHaveBeenCalledWith(
        "org-1",
        "tasks",
        expect.objectContaining({ source: "user" }),
      );
    });

    it("resolves source to chat when X-Paperclip-Ui: chat is set", async () => {
      mockSurfaceFlagsService.set.mockResolvedValue({ surfaceKey: "tasks", unveiled: true, source: "chat" });
      const res = await request(await createApp())
        .put("/orgs/org-1/surfaces/tasks")
        .set("X-Paperclip-Ui", "chat")
        .send({ unveiled: true, reason: "the assistant unveiled it" });
      expect(res.status).toBe(200);
      expect(mockSurfaceFlagsService.set).toHaveBeenCalledWith(
        "org-1",
        "tasks",
        expect.objectContaining({ source: "chat" }),
      );
    });

    it("404s for an unknown surface key", async () => {
      const res = await request(await createApp())
        .put("/orgs/org-1/surfaces/not-a-real-surface")
        .send({ unveiled: true, reason: "x" });
      expect(res.status).toBe(404);
      expect(mockSurfaceFlagsService.set).not.toHaveBeenCalled();
    });

    it("rejects a body missing reason", async () => {
      const res = await request(await createApp())
        .put("/orgs/org-1/surfaces/tasks")
        .send({ unveiled: true });
      expect(res.status).toBe(400);
      expect(mockSurfaceFlagsService.set).not.toHaveBeenCalled();
    });
  });

  describe("POST /orgs/:orgId/surfaces/reconcile", () => {
    it("reconciles against a freshly computed facts snapshot", async () => {
      mockSurfaceFlagsService.reconcile.mockResolvedValue([{ surfaceKey: "tasks", unveiled: true, reason: "run started" }]);
      const res = await request(await createApp()).post("/orgs/org-1/surfaces/reconcile").send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ diff: [{ surfaceKey: "tasks", unveiled: true, reason: "run started" }], facts: FACTS });
      expect(mockSurfaceFlagsService.reconcile).toHaveBeenCalledWith("org-1", FACTS);
    });
  });

  describe("GET /orgs/:orgId/facts", () => {
    it("returns the raw OrgFacts snapshot", async () => {
      const res = await request(await createApp()).get("/orgs/org-1/facts");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ facts: FACTS });
    });
  });
});
