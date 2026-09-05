import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUiPreferenceService = vi.hoisted(() => ({
  getForUser: vi.fn(),
  upsertForUser: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    uiPreferenceService: () => mockUiPreferenceService,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const [{ uiPreferenceRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/ui-preferences.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", uiPreferenceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const BOARD_ACTOR = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};

describe("ui preference routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/ui-preferences.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockUiPreferenceService.getForUser.mockResolvedValue({ theme: null, showAllSurfaces: false, updatedAt: null });
    mockUiPreferenceService.upsertForUser.mockImplementation(async (_userId: string, patch: { theme?: string; showAllSurfaces?: boolean }) => ({
      theme: patch.theme ?? null,
      showAllSurfaces: patch.showAllSurfaces ?? false,
      updatedAt: null,
    }));
  });

  it("returns a null theme for users who never chose (UI resolves to the dark default)", async () => {
    const app = await createApp(BOARD_ACTOR);

    const res = await request(app).get("/api/ui-preferences/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: null, showAllSurfaces: false, updatedAt: null });
    expect(mockUiPreferenceService.getForUser).toHaveBeenCalledWith("user-1");
  });

  it("round-trips a stored theme through PUT then GET", async () => {
    const app = await createApp(BOARD_ACTOR);

    const putRes = await request(app)
      .put("/api/ui-preferences/me")
      .send({ theme: "system" });
    expect(putRes.status).toBe(200);
    expect(putRes.body.theme).toBe("system");
    expect(mockUiPreferenceService.upsertForUser).toHaveBeenCalledWith("user-1", { theme: "system" });

    mockUiPreferenceService.getForUser.mockResolvedValue({ theme: "system", showAllSurfaces: false, updatedAt: null });
    const getRes = await request(app).get("/api/ui-preferences/me");
    expect(getRes.status).toBe(200);
    expect(getRes.body.theme).toBe("system");
  });

  it("round-trips showAllSurfaces independently of theme", async () => {
    const app = await createApp(BOARD_ACTOR);

    const putRes = await request(app)
      .put("/api/ui-preferences/me")
      .send({ showAllSurfaces: true });
    expect(putRes.status).toBe(200);
    expect(putRes.body.showAllSurfaces).toBe(true);
    expect(mockUiPreferenceService.upsertForUser).toHaveBeenCalledWith("user-1", { showAllSurfaces: true });
  });

  it("rejects an empty PUT body (neither theme nor showAllSurfaces)", async () => {
    const app = await createApp(BOARD_ACTOR);

    const res = await request(app).put("/api/ui-preferences/me").send({});

    expect(res.status).toBe(400);
    expect(mockUiPreferenceService.upsertForUser).not.toHaveBeenCalled();
  });

  it("rejects theme values outside the light/dark/system enum", async () => {
    const app = await createApp(BOARD_ACTOR);

    const res = await request(app)
      .put("/api/ui-preferences/me")
      .send({ theme: "solarized" });

    expect(res.status).toBe(400);
    expect(mockUiPreferenceService.upsertForUser).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/ui-preferences/me");

    expect(res.status).toBe(403);
    expect(mockUiPreferenceService.getForUser).not.toHaveBeenCalled();
  });
});
