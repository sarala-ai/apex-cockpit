/**
 * Cockpit MCP — the Veil tool surface (get_org_facts, list_surfaces,
 * set_surface_veil, suggest_next, run_workflow, search_docs, get_guidance,
 * docs_tags).
 *
 * org-facts/surface-flags/workflows-cli/docs-cli are mocked at the module
 * boundary — this suite is about the MCP layer's wiring (capability gate,
 * audit attribution, output-schema enforcement), not about re-deriving
 * OrgFacts or re-testing the CLI clients (see org-facts.test.ts,
 * surface-flags-service.test.ts, docs-cli.test.ts, workflows-cli.test.ts for
 * those). The DB is the same chainable stub cockpit-mcp-principal-auth.test.ts
 * uses, extended with a `companies` row so resolveCompanyContext resolves.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { activityLog, authUsers, companies, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { mcpRoutes } from "../mcp/router.js";
import { mintCockpitMcpJwt } from "../mcp/cockpit-mcp-jwt.js";
import { CAP_BOARD_READ, CAP_VEIL_WRITE } from "../mcp/capabilities.js";
import { operatorClaims, signPrincipalJwt, testPrincipalKey } from "./helpers/principal-jwt.js";

const ACCEPT = "application/json, text/event-stream";
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ORG = "99999999-9999-4999-8999-999999999999";

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

const mockComputeOrgFacts = vi.hoisted(() => vi.fn());
const mockSurfaceFlagsService = vi.hoisted(() => ({ list: vi.fn(), set: vi.fn(), reconcile: vi.fn() }));
const mockWorkflowsList = vi.hoisted(() => vi.fn());
const mockWorkflowsShow = vi.hoisted(() => vi.fn());
const mockDocsSearch = vi.hoisted(() => vi.fn());
const mockDocsList = vi.hoisted(() => vi.fn());
const mockDocsTags = vi.hoisted(() => vi.fn());

vi.mock("../services/org-facts.js", () => ({ computeOrgFacts: mockComputeOrgFacts }));
vi.mock("../services/surface-flags.js", () => ({ surfaceFlagsService: () => mockSurfaceFlagsService }));
vi.mock("../apex/workflows-cli.js", () => ({
  WorkflowsCliClient: class {
    list = mockWorkflowsList;
    show = mockWorkflowsShow;
  },
}));
vi.mock("../apex/docs-cli.js", () => ({
  DocsCliClient: class {
    search = mockDocsSearch;
    list = mockDocsList;
    tags = mockDocsTags;
  },
}));

function parseSseJsonRpc(text: string): Record<string, unknown> {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      try {
        return JSON.parse(trimmed.slice("data:".length).trim()) as Record<string, unknown>;
      } catch {
        // not this line
      }
    }
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params });
const toolCall = (id: number, name: string, args: Record<string, unknown> = {}) =>
  rpc(id, "tools/call", { name, arguments: args });

/** Chainable, thenable stub for drizzle's select builder — same shape as
 *  cockpit-mcp-principal-auth.test.ts's fakeDb, extended with a `companies`
 *  row so resolveCompanyContext (router.ts) resolves org_id + issue_prefix. */
function fakeDb() {
  const activity: Array<Record<string, unknown>> = [];
  const select = () => {
    let table: unknown;
    const chain: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "limit", "innerJoin"]) {
      chain[m] = (arg: unknown) => {
        if (m === "from") table = arg;
        return chain;
      };
    }
    chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rowsFor(table)).then(resolve, reject);
    return chain;
  };
  function rowsFor(table: unknown): unknown[] {
    if (table === authUsers) return [{ id: "user-1", name: "Op", email: "op@example.com" }];
    if (table === companyMemberships) return [{ companyId: COMPANY, membershipRole: "owner", status: "active" }];
    if (table === instanceUserRoles) return [];
    if (table === companies) return [{ orgId: ORG, issuePrefix: "ACME" }];
    return [];
  }
  return {
    activity,
    db: {
      select,
      insert: (table: unknown) => ({
        values(values: Record<string, unknown>) {
          if (table === activityLog) activity.push(values);
          return Promise.resolve([]);
        },
      }),
    } as any,
  };
}

const key = testPrincipalKey();

function appFor() {
  const { db, activity } = fakeDb();
  const app = express();
  app.use(express.json());
  app.use(mcpRoutes(db, { principalJwtVerifier: key.verifier }));
  return { app, activity };
}

const post = (app: express.Express, token: string, body: unknown) =>
  request(app).post("/mcp").set("Authorization", `Bearer ${token}`).set("Accept", ACCEPT).send(body);

describe("cockpit-mcp — Veil tools", () => {
  beforeAll(() => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "cockpit-mcp-veil-test-secret-min-32-chars!!");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("operator JWT can set a veil: audit ok, event row source chat with actor_user_id", async () => {
    mockSurfaceFlagsService.set.mockResolvedValue({
      surfaceKey: "pipelines",
      unveiled: true,
      source: "chat",
      reason: "operator asked",
      actorUserId: "user-1",
      actorRunId: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const { app, activity } = appFor();
    const token = signPrincipalJwt(key, operatorClaims({ companyId: COMPANY, companies: [] }));

    const res = await post(
      app,
      token,
      toolCall(1, "set_surface_veil", { surfaceKey: "pipelines", unveiled: true, reason: "operator asked" }),
    );
    expect(res.status).toBe(200);
    const body = parseSseJsonRpc(res.text) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    const parsed = JSON.parse(body.result.content[0]!.text);
    expect(parsed.flag.source).toBe("chat");

    expect(mockSurfaceFlagsService.set).toHaveBeenCalledWith(
      ORG,
      "pipelines",
      expect.objectContaining({ unveiled: true, source: "chat", actorUserId: "user-1", actorRunId: null }),
    );

    const okRow = activity.find((r) => (r.details as Record<string, unknown>)?.outcome === "ok");
    expect(okRow).toBeDefined();
    expect(okRow!.actorType).toBe("user");
    expect(okRow!.actorId).toBe("user-1");
    expect((okRow!.details as Record<string, unknown>).tool).toBe("set_surface_veil");
  });

  it("run JWT without CAP_VEIL_WRITE is denied, with a denied audit row", async () => {
    const { app, activity } = appFor();
    const runId = "55555555-5555-4555-8555-555555555555";
    const token = mintCockpitMcpJwt({
      agentId: "44444444-4444-4444-8444-444444444444",
      companyId: COMPANY,
      runId,
      adapterType: "claude_local",
      grantedCapabilities: [CAP_BOARD_READ], // NOT veil:write
    });
    expect(token).toBeTruthy();

    const res = await post(
      app,
      token!,
      toolCall(1, "set_surface_veil", { surfaceKey: "pipelines", unveiled: true, reason: "should be denied" }),
    );
    expect(res.status).toBe(200);
    const body = parseSseJsonRpc(res.text) as { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: unknown };
    const isError = body.result?.isError === true || body.error !== undefined;
    expect(isError).toBe(true);
    expect(mockSurfaceFlagsService.set).not.toHaveBeenCalled();

    const deniedRow = activity.find((r) => (r.details as Record<string, unknown>)?.outcome === "denied");
    expect(deniedRow).toBeDefined();
    expect((deniedRow!.details as Record<string, unknown>).tool).toBe("set_surface_veil");
    expect((deniedRow!.details as Record<string, unknown>).requiredCapability).toBe(CAP_VEIL_WRITE);
  });

  it("a run token CAN hold veil:write when its lifecycle node declared it (adapterConfig.grantedCapabilities)", async () => {
    mockSurfaceFlagsService.set.mockResolvedValue({
      surfaceKey: "pipelines",
      unveiled: false,
      source: "chat",
      reason: "run asked",
      actorUserId: null,
      actorRunId: "66666666-6666-4666-8666-666666666666",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const { app, activity } = appFor();
    const runId = "66666666-6666-4666-8666-666666666666";
    const token = mintCockpitMcpJwt({
      agentId: "44444444-4444-4444-8444-444444444444",
      companyId: COMPANY,
      runId,
      adapterType: "claude_local",
      grantedCapabilities: [CAP_BOARD_READ, CAP_VEIL_WRITE],
    });

    const res = await post(app, token!, toolCall(1, "set_surface_veil", { surfaceKey: "pipelines", unveiled: false, reason: "run asked" }));
    expect(res.status).toBe(200);
    const body = parseSseJsonRpc(res.text) as { result: { isError?: boolean } };
    expect(body.result.isError).toBeFalsy();
    expect(mockSurfaceFlagsService.set).toHaveBeenCalledWith(
      ORG,
      "pipelines",
      expect.objectContaining({ actorUserId: null, actorRunId: runId }),
    );
    const okRow = activity.find((r) => (r.details as Record<string, unknown>)?.outcome === "ok");
    expect(okRow!.runId).toBe(runId);
  });

  it("get_org_facts and list_surfaces return board:read data for an operator", async () => {
    mockComputeOrgFacts.mockResolvedValue(FACTS);
    mockSurfaceFlagsService.list.mockResolvedValue([
      { key: "dashboard", label: "Dashboard", section: "top", routes: [], navPath: "/dashboard", stage: 1, always: false, flag: null, due: { due: true, reason: "present from day one" }, visible: true },
    ]);
    const { app } = appFor();
    const token = signPrincipalJwt(key, operatorClaims({ companyId: COMPANY, companies: [] }));

    const factsRes = await post(app, token, toolCall(1, "get_org_facts"));
    const factsBody = parseSseJsonRpc(factsRes.text) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(factsBody.result.content[0]!.text).facts).toEqual(FACTS);

    const surfacesRes = await post(app, token, toolCall(2, "list_surfaces"));
    const surfacesBody = parseSseJsonRpc(surfacesRes.text) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(surfacesBody.result.content[0]!.text).surfaces).toHaveLength(1);
    expect(mockSurfaceFlagsService.list).toHaveBeenCalledWith(ORG, FACTS, false);
  });

  it("suggest_next validates against its output schema — every item has an action", async () => {
    mockComputeOrgFacts.mockResolvedValue(FACTS);
    mockSurfaceFlagsService.list.mockResolvedValue([
      { key: "dashboard", label: "Dashboard", section: "top", routes: [], navPath: "/dashboard", stage: 1, always: false, flag: null, due: { due: true, reason: "present from day one" }, visible: true },
      { key: "chat", label: "Chat", section: "top", routes: [], navPath: "/board-chat", stage: 1, always: true, flag: null, due: { due: true, reason: "always visible" }, visible: true },
      { key: "settings", label: "Settings", section: "settings", routes: [], navPath: "/company/settings", stage: 1, always: false, flag: { surfaceKey: "settings", unveiled: false, source: "default", reason: null, actorUserId: null, actorRunId: null, updatedAt: "2026-01-01T00:00:00.000Z" }, due: { due: false, reason: "settings is never auto-unveiled by rule" }, visible: false },
    ]);
    mockWorkflowsList.mockResolvedValue({
      ok: true,
      data: { status: "success", workflows: [{ name: "deploy-cloud-run", path: "x.yaml", source: "repo", layer: "repo", lifecycle: "active", shadowed_count: 0, shadows_other_layer: false }] },
    });

    const { app } = appFor();
    const token = signPrincipalJwt(key, operatorClaims({ companyId: COMPANY, companies: [] }));
    const res = await post(app, token, toolCall(1, "suggest_next"));
    expect(res.status).toBe(200);
    const body = parseSseJsonRpc(res.text) as {
      result: { structuredContent?: { suggestions: Array<Record<string, unknown>> }; isError?: boolean };
    };
    expect(body.result.isError).toBeFalsy();
    const suggestions = body.result.structuredContent!.suggestions;
    expect(suggestions.length).toBeGreaterThan(0);
    for (const item of suggestions) {
      expect(item.action).toBeDefined();
      expect((item.action as { href: string }).href).toBeTruthy();
      expect(["workflow", "route", "consent"]).toContain((item.action as { kind: string }).kind);
    }
    // "chat" is always-visible and excluded (not "freshly due"); "settings"
    // already has a flag and is excluded too — only "dashboard" (visible,
    // never flagged) plus the one cataloged workflow should appear.
    expect(suggestions.some((s) => s.surfaceKey === "dashboard")).toBe(true);
    expect(suggestions.some((s) => (s.workflow as { name?: string } | undefined)?.name === "deploy-cloud-run")).toBe(true);
  });

  it("run_workflow never executes — returns an href + runVia pointer only", async () => {
    mockWorkflowsShow.mockResolvedValue({ ok: true, data: { status: "success", name: "deploy-cloud-run" } });
    const { app } = appFor();
    const token = signPrincipalJwt(key, operatorClaims({ companyId: COMPANY, companies: [] }));
    const res = await post(app, token, toolCall(1, "run_workflow", { name: "deploy-cloud-run" }));
    const body = parseSseJsonRpc(res.text) as { result: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(body.result.content[0]!.text);
    expect(parsed).toEqual({ href: "/ACME/workflows/deploy-cloud-run", runVia: "pipeline_step" });
  });

  it("search_docs/get_guidance/docs_tags degrade cleanly (classified tool error, never a crash) when apex is missing", async () => {
    const cliMissing = {
      status: "error" as const,
      error_type: "cli_missing_command",
      message: "requires an installed apex-platform build with the `apex docs` CLI",
      remediation: "Install apex.",
    };
    mockDocsSearch.mockResolvedValue({ ok: false, error: cliMissing });
    mockDocsList.mockResolvedValue({ ok: false, error: cliMissing });
    mockDocsTags.mockResolvedValue({ ok: false, error: cliMissing });

    const { app } = appFor();
    const token = signPrincipalJwt(key, operatorClaims({ companyId: COMPANY, companies: [] }));

    for (const call of [
      toolCall(1, "search_docs", { q: "deploy cloud run" }),
      toolCall(2, "get_guidance", { stage: ["2"] }),
      toolCall(3, "docs_tags"),
    ]) {
      const res = await post(app, token, call);
      expect(res.status).toBe(200); // never a crash / 500
      const body = parseSseJsonRpc(res.text) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(body.result.isError).toBe(true);
      const parsed = JSON.parse(body.result.content[0]!.text);
      expect(parsed.error_type).toBe("cli_missing_command");
    }
  });
});
