import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock authz so we don't need a real session
vi.mock("../routes/authz.js", () => ({
  assertBoardOrAgent: () => {},
}));

// Mock the model-access module so tests don't hit the gateway or spawn claude
const mockReadModelAccessState = vi.hoisted(() => vi.fn());
const mockProvisionClaudeSubscription = vi.hoisted(() => vi.fn());
const mockProvisionClaudeApiKey = vi.hoisted(() => vi.fn());
const mockProvisionOpenRouter = vi.hoisted(() => vi.fn());
const mockDetectClaudeAuth = vi.hoisted(() => vi.fn());
const mockDetectClaudeAuthForOperator = vi.hoisted(() => vi.fn());
const mockBridgeAvailable = vi.hoisted(() => vi.fn(() => true));

vi.mock("../apex/model-access/index.js", () => ({
  readModelAccessState: mockReadModelAccessState,
  provisionClaudeSubscription: mockProvisionClaudeSubscription,
  provisionClaudeApiKey: mockProvisionClaudeApiKey,
  provisionOpenRouter: mockProvisionOpenRouter,
  subscriptionBridgeAvailable: mockBridgeAvailable,
}));

vi.mock("../apex/model-access/detect-claude.js", () => ({
  detectClaudeAuth: mockDetectClaudeAuth,
  detectClaudeAuthForOperator: mockDetectClaudeAuthForOperator,
}));

const { apexSetupModelsRoutes } = await import("../routes/apex-setup-models.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "board", userId: "user-1" };
    next();
  });
  app.use(apexSetupModelsRoutes({} as any, {} as any));
  return app;
}

const stateFixture = {
  claude: { mode: "subscription", installed: true, subscriptionProviderRegistered: true, apiKeyProviderRegistered: false },
  openrouter: { configured: false },
  aliasesRegistered: ["apex-judge-default", "apex-chat-general", "apex-smart", "apex-fast"],
};

describe("GET /setup/models — state probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridgeAvailable.mockReturnValue(true);
  });

  it("returns the ModelAccessState snapshot with claude facts scoped to the operator", async () => {
    mockReadModelAccessState.mockResolvedValue(stateFixture);
    const detect = Promise.resolve({ mode: "unknown", installed: null, source: "unknown", reportedAt: null });
    mockDetectClaudeAuthForOperator.mockReturnValue(detect);
    const res = await request(makeApp()).get("/setup/models");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(stateFixture);
    expect(mockDetectClaudeAuthForOperator).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(mockReadModelAccessState).toHaveBeenCalledWith(expect.anything(), detect);
  });

  it("propagates gateway errors as 500", async () => {
    mockReadModelAccessState.mockRejectedValue(new Error("gateway gone"));
    const res = await request(makeApp()).get("/setup/models");
    expect(res.status).toBe(500);
  });
});

describe("POST /setup/models/claude/provision — subscription bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBridgeAvailable.mockReturnValue(true);
  });

  it("is refused with a classified error on a hosted deployment, before any detection", async () => {
    mockBridgeAvailable.mockReturnValue(false);
    const res = await request(makeApp()).post("/setup/models/claude/provision").send({});
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ code: "not_available_on_hosted" });
    expect(res.body.error).toMatch(/hosted/i);
    expect(mockDetectClaudeAuth).not.toHaveBeenCalled();
    expect(mockProvisionClaudeSubscription).not.toHaveBeenCalled();
  });

  it("provisions successfully when claude subscription is detected", async () => {
    mockDetectClaudeAuth.mockResolvedValue({ mode: "subscription", installed: true });
    mockProvisionClaudeSubscription.mockResolvedValue({
      ok: true,
      providerName: "claude-subscription-bridge",
      aliasesSeeded: ["apex-judge-default"],
    });

    const res = await request(makeApp()).post("/setup/models/claude/provision").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.providerName).toBe("claude-subscription-bridge");
  });

  it("returns a classified 428 naming the in-UI ceremony when claude is not authenticated", async () => {
    mockDetectClaudeAuth.mockResolvedValue({ mode: "none", installed: false });
    const res = await request(makeApp()).post("/setup/models/claude/provision").send({});
    expect(res.status).toBe(428);
    expect(res.body.error).toMatch(/not authenticated/i);
    expect(res.body.code).toBe("claude_session_required");
    expect(res.body.hint).toMatch(/Connect Claude subscription/);
    expect(JSON.stringify(res.body)).not.toMatch(/claude login/);
    expect(mockProvisionClaudeSubscription).not.toHaveBeenCalled();
  });

  it("treats 409 (already provisioned) as idempotent success — provisionClaudeSubscription handles it", async () => {
    // The route delegates idempotency to provisionClaudeSubscription which internally
    // handles 409 conflicts and returns ok:true. Simulate the already-provisioned path.
    mockDetectClaudeAuth.mockResolvedValue({ mode: "subscription", installed: true });
    mockProvisionClaudeSubscription.mockResolvedValue({
      ok: true,
      providerName: "claude-subscription-bridge",
      aliasesSeeded: ["apex-judge-default", "apex-chat-general", "apex-smart", "apex-fast"],
    });

    const res = await request(makeApp()).post("/setup/models/claude/provision").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("redirects api_key detection to the api-key endpoint with 428", async () => {
    mockDetectClaudeAuth.mockResolvedValue({ mode: "api_key", installed: true });
    const res = await request(makeApp()).post("/setup/models/claude/provision").send({});
    expect(res.status).toBe(428);
    expect(res.body.error).toMatch(/api-key endpoint/i);
  });

  it("returns 502 when provisioning fails downstream", async () => {
    mockDetectClaudeAuth.mockResolvedValue({ mode: "subscription", installed: true });
    mockProvisionClaudeSubscription.mockResolvedValue({ ok: false, reason: "gateway unreachable" });
    const res = await request(makeApp()).post("/setup/models/claude/provision").send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("gateway unreachable");
  });
});

describe("POST /setup/models/claude/api-key", () => {
  beforeEach(() => vi.clearAllMocks());

  it("provisions api_key mode with a valid key", async () => {
    mockProvisionClaudeApiKey.mockResolvedValue({
      ok: true,
      providerName: "claude-api-key",
      aliasesSeeded: ["apex-judge-default"],
    });

    const res = await request(makeApp())
      .post("/setup/models/claude/api-key")
      .send({ apiKey: "sk-ant-test-key" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockProvisionClaudeApiKey).toHaveBeenCalledWith("sk-ant-test-key", expect.anything());
  });

  it("returns 400 when apiKey is missing", async () => {
    const res = await request(makeApp()).post("/setup/models/claude/api-key").send({});
    expect(res.status).toBe(400);
    expect(mockProvisionClaudeApiKey).not.toHaveBeenCalled();
  });
});

describe("POST /setup/models/openrouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("provisions openrouter with a valid key", async () => {
    mockProvisionOpenRouter.mockResolvedValue({
      ok: true,
      providerName: "openrouter",
      aliasesSeeded: [],
    });

    const res = await request(makeApp())
      .post("/setup/models/openrouter")
      .send({ apiKey: "sk-or-test" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 400 when apiKey is missing", async () => {
    const res = await request(makeApp()).post("/setup/models/openrouter").send({});
    expect(res.status).toBe(400);
  });
});
