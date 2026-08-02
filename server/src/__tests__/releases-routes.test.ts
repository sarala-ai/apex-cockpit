import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReleaseService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  detail: vi.fn(),
  buildNotes: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  promote: vi.fn(),
  close: vi.fn(),
  attachChanges: vi.fn(),
  addArtifact: vi.fn(),
  computeConfoundSet: vi.fn(),
  confoundsForRelease: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/releases.js", () => ({
  releaseService: () => mockReleaseService,
}));

vi.mock("../services/index.js", () => ({
  logActivity: mockLogActivity,
}));

const RELEASE = {
  id: "release-1",
  companyId: "company-1",
  version: "1.0.0",
  name: null,
  status: "released",
  closure: null,
  closureReason: null,
  environment: "prod",
  promotedFromReleaseId: null,
  releasedAt: new Date("2026-08-01T00:00:00.000Z"),
  observationWindowEndsAt: new Date("2026-08-08T00:00:00.000Z"),
  closedAt: null,
  createdAt: new Date("2026-07-30T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { releaseRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/releases.js") as Promise<typeof import("../routes/releases.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", releaseRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

describe.sequential("release routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockReleaseService)) mock.mockReset();
    mockLogActivity.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("lists a product's releases", async () => {
    mockReleaseService.list.mockResolvedValue([RELEASE]);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/releases"),
    );
    expect(res.status).toBe(200);
    expect(mockReleaseService.list).toHaveBeenCalledWith("company-1");
    expect(res.body).toHaveLength(1);
  });

  it("refuses a company the actor has no access to", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-2/releases"),
    );
    expect(res.status).toBe(403);
    expect(mockReleaseService.list).not.toHaveBeenCalled();
  });

  it("refuses a release detail belonging to another company", async () => {
    // Scoping is re-derived from the row, not trusted from the URL.
    mockReleaseService.getById.mockResolvedValue({ ...RELEASE, companyId: "company-9" });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/releases/release-1"));
    expect(res.status).toBe(403);
    expect(mockReleaseService.detail).not.toHaveBeenCalled();
  });

  it("404s an unknown release", async () => {
    mockReleaseService.getById.mockResolvedValue(null);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/releases/missing"));
    expect(res.status).toBe(404);
  });

  it("returns generated notes", async () => {
    mockReleaseService.getById.mockResolvedValue(RELEASE);
    mockReleaseService.buildNotes.mockResolvedValue({
      releaseId: "release-1",
      markdown: "# 1.0.0\n",
      sections: [],
      artifacts: [],
      confoundWarning: null,
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/releases/release-1/notes"),
    );
    expect(res.status).toBe(200);
    expect(res.body.markdown).toContain("# 1.0.0");
  });

  it("answers the confound question for a window", async () => {
    mockReleaseService.computeConfoundSet.mockResolvedValue({ clean: true, warning: null });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(
        "/api/companies/company-1/releases/confounds?windowStart=2026-08-01T00:00:00.000Z&windowEnd=2026-08-08T00:00:00.000Z&initiativeId=3f1f3a2c-0c2b-4a0a-9d0d-4c9d9c3f4b21",
      ),
    );
    expect(res.status).toBe(200);
    expect(mockReleaseService.computeConfoundSet).toHaveBeenCalledWith({
      companyId: "company-1",
      windowStart: new Date("2026-08-01T00:00:00.000Z"),
      windowEnd: new Date("2026-08-08T00:00:00.000Z"),
      initiativeId: "3f1f3a2c-0c2b-4a0a-9d0d-4c9d9c3f4b21",
    });
  });

  it("rejects a confound query with no window", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/releases/confounds"),
    );
    expect(res.status).toBe(400);
    expect(mockReleaseService.computeConfoundSet).not.toHaveBeenCalled();
  });

  it("creates a release and records the activity", async () => {
    mockReleaseService.create.mockResolvedValue(RELEASE);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/companies/company-1/releases")
        .send({ version: "1.0.0", environment: "prod" }),
    );
    expect(res.status).toBe(201);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "release.created", entityType: "release" }),
    );
  });

  it("rejects a release with no version", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/companies/company-1/releases").send({ environment: "prod" }),
    );
    expect(res.status).toBe(400);
    expect(mockReleaseService.create).not.toHaveBeenCalled();
  });

  it("promotes into a new release", async () => {
    mockReleaseService.getById.mockResolvedValue(RELEASE);
    mockReleaseService.promote.mockResolvedValue({ ...RELEASE, id: "release-2", environment: "prod2" });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/releases/release-1/promote").send({ environment: "prod2" }),
    );
    expect(res.status).toBe(201);
    expect(mockReleaseService.promote).toHaveBeenCalledWith(
      "release-1",
      expect.objectContaining({ environment: "prod2" }),
    );
  });

  it("requires a reason to close", async () => {
    mockReleaseService.getById.mockResolvedValue(RELEASE);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post("/api/releases/release-1/close").send({ closure: "rolled_back" }),
    );
    expect(res.status).toBe(400);
    expect(mockReleaseService.close).not.toHaveBeenCalled();
  });

  it("rejects an unknown closure value", async () => {
    mockReleaseService.getById.mockResolvedValue(RELEASE);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/releases/release-1/close")
        .send({ closure: "mostly_fine", closureReason: "eh" }),
    );
    expect(res.status).toBe(400);
  });

  it("closes with a reason", async () => {
    mockReleaseService.getById.mockResolvedValue(RELEASE);
    mockReleaseService.close.mockResolvedValue({
      ...RELEASE,
      closure: "rolled_back",
      closureReason: "checkout broke",
    });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/releases/release-1/close")
        .send({ closure: "rolled_back", closureReason: "checkout broke" }),
    );
    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "release.closed" }),
    );
  });

  it("attaches changes", async () => {
    mockReleaseService.getById.mockResolvedValue(RELEASE);
    mockReleaseService.attachChanges.mockResolvedValue([]);
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/releases/release-1/changes")
        .send({ issueIds: ["3f1f3a2c-0c2b-4a0a-9d0d-4c9d9c3f4b21"] }),
    );
    expect(res.status).toBe(201);
  });

  it("records an artifact tag", async () => {
    mockReleaseService.getById.mockResolvedValue(RELEASE);
    mockReleaseService.addArtifact.mockResolvedValue({ id: "artifact-1" });
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl)
        .post("/api/releases/release-1/artifacts")
        .send({ repo: "sarala-ai/finpilot", tag: "v1.0.0" }),
    );
    expect(res.status).toBe(201);
    expect(mockReleaseService.addArtifact).toHaveBeenCalledWith(
      "release-1",
      expect.objectContaining({ repo: "sarala-ai/finpilot", tag: "v1.0.0" }),
    );
  });
});
