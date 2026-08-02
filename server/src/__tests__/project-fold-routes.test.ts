import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  updateWorkspace: vi.fn(),
  removeWorkspace: vi.fn(),
  remove: vi.fn(),
  resolveByReference: vi.fn(),
}));
const mockSecretService = vi.hoisted(() => ({
  normalizeEnvBindingsForPersistence: vi.fn(),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());
const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  environmentService: () => mockEnvironmentService,
  logActivity: mockLogActivity,
  projectService: () => mockProjectService,
  secretService: () => mockSecretService,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/environments.js", () => ({
  environmentService: () => mockEnvironmentService,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

vi.mock("../services/workspace-runtime.js", () => ({
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForProjectWorkspace: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    environmentService: () => mockEnvironmentService,
    logActivity: mockLogActivity,
    projectService: () => mockProjectService,
    secretService: () => mockSecretService,
    workspaceOperationService: () => mockWorkspaceOperationService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));

  vi.doMock("../services/secrets.js", () => ({
    secretService: () => mockSecretService,
  }));

  vi.doMock("../services/workspace-runtime.js", () => ({
    startRuntimeServicesForWorkspaceControl: vi.fn(),
    stopRuntimeServicesForProjectWorkspace: vi.fn(),
  }));
}

async function createApp() {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/projects.js")>("../routes/projects.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-1",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project",
    description: null,
    status: "backlog",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
      repoName: null,
      localFolder: null,
      managedFolder: "/tmp/project",
      effectiveLocalFolder: "/tmp/project",
      origin: "managed_checkout",
    },
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("project routes — folding a project", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/projects.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../services/environments.js");
    vi.doUnmock("../services/secrets.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "project:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockProjectService.resolveByReference.mockResolvedValue({ ambiguous: false, project: null });
    mockProjectService.createWorkspace.mockResolvedValue(null);
    mockProjectService.listWorkspaces.mockResolvedValue([]);
    mockSecretService.normalizeEnvBindingsForPersistence.mockImplementation(
      async (_companyId: string, env: unknown) => env,
    );
    mockProjectService.getById.mockResolvedValue(buildProject());
    mockProjectService.update.mockImplementation(async (_id: string, data: any) =>
      buildProject(data),
    );
  });

  const GOAL_ID = "22222222-2222-4222-8222-222222222222";
  const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333";

  it("records a fold into another initiative, with its link", async () => {
    // "Skill packs as the moat" folded into another initiative and had to be
    // recorded as `cancelled` with prose explaining it was not abandoned.
    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({ status: "folded", foldedIntoGoalId: GOAL_ID });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("folded");
    expect(res.body.foldedIntoGoalId).toBe(GOAL_ID);
  });

  it("records a fold into a sibling project", async () => {
    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({ status: "folded", foldedIntoProjectId: OTHER_PROJECT });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.foldedIntoProjectId).toBe(OTHER_PROJECT);
  });

  it("allows a fold whose destination is not on the board yet", async () => {
    const app = await createApp();
    const res = await request(app).patch("/api/projects/project-1").send({ status: "folded" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("refuses a fold link on a project that did not fold", async () => {
    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({ foldedIntoGoalId: GOAL_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("folded");
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("checks the links against the status the project WILL have", async () => {
    // The stored row is already folded, and the patch only moves it back.
    mockProjectService.getById.mockResolvedValue(
      buildProject({ status: "folded", foldedIntoGoalId: GOAL_ID }),
    );
    const app = await createApp();
    const res = await request(app)
      .patch("/api/projects/project-1")
      .send({ status: "in_progress" });

    expect(res.status).toBe(400);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("refuses two destinations, and a project folding into itself", async () => {
    const app = await createApp();
    const both = await request(app)
      .patch("/api/projects/project-1")
      .send({ status: "folded", foldedIntoGoalId: GOAL_ID, foldedIntoProjectId: OTHER_PROJECT });
    expect(both.status).toBe(400);

    mockProjectService.getById.mockResolvedValue(buildProject({ id: OTHER_PROJECT }));
    const self = await request(app)
      .patch(`/api/projects/${OTHER_PROJECT}`)
      .send({ status: "folded", foldedIntoProjectId: OTHER_PROJECT });
    expect(self.status).toBe(400);
    expect(self.body.error).toContain("itself");
  });

  it("accepts built as a status of its own, distinct from completed", async () => {
    // Four real projects sat in `in_progress` because `completed` would have
    // claimed an exercise nobody performed.
    const app = await createApp();
    const res = await request(app).patch("/api/projects/project-1").send({ status: "built" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("built");
  });
});
