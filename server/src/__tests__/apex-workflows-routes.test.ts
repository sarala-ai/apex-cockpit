import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { WorkflowDetailSuccess, WorkflowError, WorkflowListSuccess } from "@paperclipai/shared";
import { apexWorkflowsRoutes } from "../routes/apex-workflows.js";
import type { WorkflowsCliClient, WorkflowsCliResult } from "../apex/workflows-cli.js";
import { errorHandler } from "../middleware/index.js";

function fakeClient(
  listResult: WorkflowsCliResult<WorkflowListSuccess>,
  showResult?: WorkflowsCliResult<WorkflowDetailSuccess>,
): WorkflowsCliClient {
  return {
    list: vi.fn(async () => listResult),
    show: vi.fn(async () => showResult ?? listResult),
  } as unknown as WorkflowsCliClient;
}

/** Chainable/thenable drizzle-shaped mock resolving `.where()` to canned rows,
 *  same idiom as apex-observe-routes.test.ts. */
function makeDb(attributionRows: unknown[]) {
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(attributionRows),
      }),
    }),
  } as unknown as Db;
  return db;
}

function appWith(db: Db, client: WorkflowsCliClient) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { type: "agent", agentId: "a1" };
    next();
  });
  app.use(apexWorkflowsRoutes(db, client));
  app.use(errorHandler);
  return app;
}

const LIST_SUCCESS: WorkflowListSuccess = {
  status: "success",
  workflows: [
    { name: "deploy-cloudrun", path: "/builtin/deploy-cloudrun.yaml", source: "apex-core", layer: "built-in", lifecycle: "stable", shadowed_count: 0, shadows_other_layer: false },
    { name: "rotate-secrets", path: "~/.apex/workflows/rotate-secrets.yaml", source: "user", layer: "user", lifecycle: "beta", shadowed_count: 1, shadows_other_layer: true },
  ],
};

const DETAIL_SUCCESS: WorkflowDetailSuccess = {
  status: "success",
  name: "deploy-cloudrun",
  version: "1.2.0",
  lifecycle: "stable",
  description: "Deploys a service to Cloud Run.",
  path: "/builtin/deploy-cloudrun.yaml",
  source: "apex-core",
  layer: "built-in",
  inputs: [{ name: "project_id", type: "string", required: true, default: null, description: "GCP project" }],
  steps: [
    { name: "build", node_type: "tool_call", server_type: "gcp", tool_name: "build_image", condition: null, continue_on_error: false },
    { name: "deploy", node_type: "tool_call", server_type: "gcp", tool_name: "deploy_service", condition: "steps.build.success", continue_on_error: false },
  ],
  outputs: [{ name: "service_url" }],
  definition_yaml: "name: deploy-cloudrun\nsteps:\n  - name: build\n",
};

const CLI_MISSING: WorkflowError = {
  status: "error",
  error_type: "cli_missing_command",
  message: "requires apex-platform with the workflows CLI (unreleased)",
  remediation: "Install apex-platform.",
};

const NOT_FOUND: WorkflowError = {
  status: "error",
  error_type: "not_found",
  message: "No workflow named 'ghost'.",
  remediation: "Run `apex workflows list` to see available workflows.",
};

describe("GET /apex/workflows", () => {
  it("returns the catalog on CLI success", async () => {
    const res = await request(appWith(makeDb([]), fakeClient({ ok: true, data: LIST_SUCCESS }))).get(
      "/apex/workflows",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(LIST_SUCCESS);
    expect(res.body.workflows).toHaveLength(2);
  });

  it("degrades to a classified cli_missing_command payload instead of crashing", async () => {
    const res = await request(appWith(makeDb([]), fakeClient({ ok: false, error: CLI_MISSING }))).get(
      "/apex/workflows",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "error",
      error_type: "cli_missing_command",
      message: "requires apex-platform with the workflows CLI (unreleased)",
      remediation: "Install apex-platform.",
    });
  });
});

describe("GET /apex/workflows/:name", () => {
  it("returns the definition plus an empty footprint (honest empty state) when no attributions exist", async () => {
    const client = fakeClient({ ok: true, data: LIST_SUCCESS }, { ok: true, data: DETAIL_SUCCESS });
    const res = await request(appWith(makeDb([]), client)).get("/apex/workflows/deploy-cloudrun");

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("deploy-cloudrun");
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.definition_yaml).toContain("deploy-cloudrun");
    expect(res.body.footprint).toEqual({ resources: [], count: 0, note: expect.stringContaining("db-known attribution only") });
  });

  it("joins resource_attributions rows into the footprint, across companies", async () => {
    const rows = [
      { resourceUri: "//run.googleapis.com/projects/p/services/svc-a", assetType: "run.googleapis.com/Service", projectId: "finpilot-dev", source: "manual" },
      { resourceUri: "//storage.googleapis.com/bucket-a", assetType: "storage.googleapis.com/Bucket", projectId: "bloom-prod", source: "auto_mapped" },
    ];
    const client = fakeClient({ ok: true, data: LIST_SUCCESS }, { ok: true, data: DETAIL_SUCCESS });
    const res = await request(appWith(makeDb(rows), client)).get("/apex/workflows/deploy-cloudrun");

    expect(res.status).toBe(200);
    expect(res.body.footprint.count).toBe(2);
    expect(res.body.footprint.resources).toEqual(rows);
  });

  it("passes through the CLI's own classified not_found error", async () => {
    const client = fakeClient({ ok: true, data: LIST_SUCCESS }, { ok: false, error: NOT_FOUND });
    const res = await request(appWith(makeDb([]), client)).get("/apex/workflows/ghost");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "error",
      error_type: "not_found",
      message: "No workflow named 'ghost'.",
      remediation: "Run `apex workflows list` to see available workflows.",
    });
  });

  it("degrades to cli_missing_command without ever calling the attribution join", async () => {
    const client = fakeClient({ ok: true, data: LIST_SUCCESS }, { ok: false, error: CLI_MISSING });
    const res = await request(appWith(makeDb([]), client)).get("/apex/workflows/deploy-cloudrun");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("error");
    expect(res.body.error_type).toBe("cli_missing_command");
    expect(res.body.footprint).toBeUndefined();
  });
});
