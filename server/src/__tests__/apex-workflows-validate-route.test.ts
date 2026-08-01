import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { WorkflowError } from "@paperclipai/shared";
import { apexWorkflowsRoutes } from "../routes/apex-workflows.js";
import type { WorkflowsCliClient } from "../apex/workflows-cli.js";
import type { WorkflowValidateCliClient, WorkflowValidateCliResult } from "../apex/workflow-validate-cli.js";
import { errorHandler } from "../middleware/index.js";

function fakeListClient(): WorkflowsCliClient {
  return { list: vi.fn(), show: vi.fn() } as unknown as WorkflowsCliClient;
}

function fakeValidateClient(result: WorkflowValidateCliResult): WorkflowValidateCliClient {
  return { validate: vi.fn(async () => result) } as unknown as WorkflowValidateCliClient;
}

function makeDb(): Db {
  return {} as unknown as Db;
}

function appWith(client: WorkflowValidateCliClient, actor: "agent" | "none" = "agent") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor =
      actor === "agent" ? { type: "agent", agentId: "a1" } : { type: "none" };
    next();
  });
  app.use(apexWorkflowsRoutes(makeDb(), fakeListClient(), client));
  app.use(errorHandler);
  return app;
}

const CLI_MISSING: WorkflowError = {
  status: "error",
  error_type: "cli_missing",
  message: "The `apex` CLI is not installed or not on PATH.",
  remediation: "Install apex-platform, then ensure `apex` is on PATH.",
};

describe("POST /apex/workflows/validate", () => {
  it("returns {valid:true, errors:[], warnings:[]} for a valid workflow", async () => {
    const client = fakeValidateClient({ ok: true, data: { valid: true, errors: [], warnings: [] } });
    const res = await request(appWith(client)).post("/apex/workflows/validate").send({ yaml: "name: wf\nsteps: []\n" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: true, errors: [], warnings: [] });
    expect(client.validate).toHaveBeenCalledWith("name: wf\nsteps: []\n");
  });

  it("returns classified errors/warnings for an invalid workflow", async () => {
    const client = fakeValidateClient({
      ok: true,
      data: { valid: false, errors: ["unknown tool 'nope'"], warnings: ["no timeout set"] },
    });
    const res = await request(appWith(client)).post("/apex/workflows/validate").send({ yaml: "name: wf\nsteps: [x]\n" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, errors: ["unknown tool 'nope'"], warnings: ["no timeout set"] });
  });

  it("degrades to a classified cli_missing payload instead of crashing", async () => {
    const client = fakeValidateClient({ ok: false, error: CLI_MISSING });
    const res = await request(appWith(client)).post("/apex/workflows/validate").send({ yaml: "name: wf\n" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "error",
      error_type: "cli_missing",
      message: "The `apex` CLI is not installed or not on PATH.",
      remediation: "Install apex-platform, then ensure `apex` is on PATH.",
    });
  });

  it("rejects a missing/non-string yaml field with 400", async () => {
    const client = fakeValidateClient({ ok: true, data: { valid: true, errors: [], warnings: [] } });
    const res = await request(appWith(client)).post("/apex/workflows/validate").send({});

    expect(res.status).toBe(400);
    expect(res.body.error_type).toBe("bad_request");
    expect(client.validate).not.toHaveBeenCalled();
  });

  it("is auth-guarded like its siblings — rejects an unauthenticated actor", async () => {
    const client = fakeValidateClient({ ok: true, data: { valid: true, errors: [], warnings: [] } });
    const res = await request(appWith(client, "none")).post("/apex/workflows/validate").send({ yaml: "name: wf\n" });

    expect(res.status).toBe(403);
    expect(client.validate).not.toHaveBeenCalled();
  });
});
