import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

vi.mock("../routes/authz.js", () => ({ assertBoardOrAgent: () => {}, assertBoard: () => {} }));

const cloud = vi.hoisted(() => ({
  listGcpProjects: vi.fn(),
  listGcpOrgs: vi.fn(),
  listGithubOrgs: vi.fn(),
  listGithubRepos: vi.fn(),
}));
vi.mock("../apex/setup/cloud.js", () => cloud);

const operatorAuth = vi.hoisted(() => ({ readWorkstationReport: vi.fn() }));
vi.mock("../apex/setup/operator-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apex/setup/operator-auth.js")>();
  return { ...actual, readWorkstationReport: operatorAuth.readWorkstationReport, resolveOperatorAuth: vi.fn() };
});

const { apexSetupRoutes } = await import("../routes/apex-setup.js");

function appWithActor(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(apexSetupRoutes({} as unknown as Db));
  return app;
}

const report = {
  gcloud: { installed: true, account: "op@sarala.ai", live: true },
  adc: { live: true },
  gh: { installed: true, user: "operator" },
  claude: { installed: true },
  apex: { installed: true, version: "0.9.0" },
};

describe("discovery routes by deployment mode", () => {
  const prevMode = process.env.PAPERCLIP_DEPLOYMENT_MODE;
  afterEach(() => {
    if (prevMode === undefined) delete process.env.PAPERCLIP_DEPLOYMENT_MODE;
    else process.env.PAPERCLIP_DEPLOYMENT_MODE = prevMode;
    vi.clearAllMocks();
  });

  it("hosted: never shells gcloud/gh; answers unavailable with the operator's workstation summary", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    operatorAuth.readWorkstationReport.mockResolvedValue({ report, reportedAt: new Date() });
    const app = appWithActor({ type: "board", userId: "user-1" });

    const projects = await request(app).get("/setup/gcp/projects");
    expect(projects.status).toBe(200);
    expect(projects.body).toMatchObject({
      projects: [],
      source: "unavailable",
      reason: "operator_workstation_required",
      workstation: { stale: false, gcloud: { account: "op@sarala.ai", live: true }, gh: { user: "operator" } },
    });
    expect(projects.body.note).toBeUndefined();

    expect((await request(app).get("/setup/gcp/orgs")).body).toMatchObject({ orgs: [], reason: "operator_workstation_required" });
    expect((await request(app).get("/setup/github/orgs")).body).toMatchObject({ orgs: [], reason: "operator_workstation_required" });
    expect((await request(app).get("/setup/github/repos?org=sarala-ai")).body).toMatchObject({ repos: [], reason: "operator_workstation_required" });

    for (const fn of Object.values(cloud)) expect(fn).not.toHaveBeenCalled();
  });

  it("hosted without a report: workstation is null, still no shell-out", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    operatorAuth.readWorkstationReport.mockResolvedValue(null);
    const res = await request(appWithActor({ type: "agent", agentId: "a1" })).get("/setup/gcp/projects");
    expect(res.body).toEqual({ projects: [], source: "unavailable", reason: "operator_workstation_required", workstation: null });
    expect(operatorAuth.readWorkstationReport).not.toHaveBeenCalled();
    expect(cloud.listGcpProjects).not.toHaveBeenCalled();
  });

  it("local: shells the server's own gcloud/gh as before", async () => {
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "local_trusted";
    cloud.listGcpProjects.mockResolvedValue({ ok: true, value: [{ projectId: "p1", name: "P1", projectNumber: "1" }], source: "gcloud" });
    cloud.listGithubRepos.mockResolvedValue({ ok: false, error: "tool-unauth", message: "Not signed in on this machine — run `apex connect gcloud` / `apex connect github`.", source: "unavailable" });
    const app = appWithActor({ type: "board", userId: "user-1" });

    const projects = await request(app).get("/setup/gcp/projects");
    expect(projects.body).toEqual({ projects: [{ projectId: "p1", name: "P1", projectNumber: "1" }], source: "gcloud" });
    const repos = await request(app).get("/setup/github/repos");
    expect(repos.body.reason).toBeUndefined();
    expect(repos.body.note).toMatch(/apex connect github/);
    expect(repos.body.note).not.toMatch(/gh auth login/);
    expect(operatorAuth.readWorkstationReport).not.toHaveBeenCalled();
  });
});

describe("cloud-binding writes validate typed ids", () => {
  it("rejects malformed ids by shape", async () => {
    const { invalidBindingIds } = await import("../routes/apex-scoping.js");
    expect(invalidBindingIds({ gcpProjects: ["finpilot-dev", "Bad_Project", "x"], githubRepos: ["sarala-ai/finpilot", "finpilot"] })).toEqual({
      gcpProjects: ["Bad_Project", "x"],
      githubRepos: ["finpilot"],
    });
  });
});
