/**
 * Workflows read surface (cockpit Workflows migration, Part 2) — the catalog
 * and detail views over apex-core's `apex workflows list`/`show` CLI, plus a
 * footprint join: which live-known resources this cockpit has attributed to
 * a given workflow.
 *
 * Read-only, shells `apex` via WorkflowsCliClient (workflows-cli.ts). The
 * core CLI's `workflows` subcommand is unreleased as of this route landing
 * (Part 1 is on an unmerged branch) — every handler degrades to a classified
 * `{status:"error",error_type:"cli_missing_command",...}` payload rather than
 * crashing or 500ing when the installed CLI doesn't recognize the command yet.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import type { WorkflowError } from "@paperclipai/shared";
import { WorkflowsCliClient } from "../apex/workflows-cli.js";
import { getAttributionsByWorkflow } from "../observe/resource-attribution-store.js";
import { assertBoardOrAgent } from "./authz.js";

const FOOTPRINT_NOTE =
  "db-known attribution only — resources this cockpit has recorded (manually or via the resource mapper) as belonging to this workflow, not a live cloud query.";

function errorPayload(error: WorkflowError) {
  return { status: "error" as const, error_type: error.error_type, message: error.message, remediation: error.remediation ?? null };
}

export function apexWorkflowsRoutes(db: Db, client: WorkflowsCliClient = new WorkflowsCliClient()) {
  const router = Router();

  // GET /apex/workflows — the catalog: every workflow the CLI can see across
  // layers (built-in / user / project), with shadowing metadata.
  router.get("/apex/workflows", async (req, res) => {
    assertBoardOrAgent(req);
    const result = await client.list();
    if (!result.ok) {
      res.json(errorPayload(result.error));
      return;
    }
    res.json(result.data);
  });

  // GET /apex/workflows/:name — one workflow's definition (inputs/steps/
  // outputs/raw YAML) plus its footprint: db-known resources attributed to it.
  router.get("/apex/workflows/:name", async (req, res) => {
    assertBoardOrAgent(req);
    const name = req.params.name;
    const result = await client.show(name);
    if (!result.ok) {
      res.json(errorPayload(result.error));
      return;
    }

    const rows = await getAttributionsByWorkflow(db, name).catch(() => []);
    const resources = rows.map((r) => ({
      resourceUri: r.resourceUri,
      assetType: r.assetType,
      projectId: r.projectId,
      source: r.source,
    }));

    res.json({
      ...result.data,
      footprint: { resources, count: resources.length, note: FOOTPRINT_NOTE },
    });
  });

  return router;
}
