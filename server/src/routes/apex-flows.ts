/**
 * Flow coordinator surface (work-loop typed flows).
 *
 *   GET  /apex/flows                    — flow definitions visible to the apex
 *                                          install (via `apex flows list`, the
 *                                          producer-owns seam).
 *   POST /apex/flows/start              — attach a flow to an issue at node 0
 *                                          and kick deterministic advancement.
 *   POST /issues/:issueId/flow/retry    — operator recovery: re-arm the
 *                                          current node (paused/failed only).
 *   POST /issues/:issueId/flow/abandon  — operator recovery: terminal-fail the
 *                                          flow cleanly (paused/failed/
 *                                          waiting_gate).
 *
 * The gate decision hook lives on the approvals routes (a `flow_gate`
 * approval's approve/reject drives the flow), mirroring the pipeline_gate
 * bridge — no parallel decision surface here.
 */
import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import { flowCoordinator } from "../apex/flow/coordinator.js";
import { listFlowDefinitions, FlowDefinitionError } from "../apex/flow/definition.js";
import { ApexUnavailableError } from "../apex/invoke.js";
import { issueService } from "../services/issues.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const startFlowSchema = z.object({
  issueId: z.string().uuid(),
  flowName: z.string().trim().min(1).max(200),
});

export function apexFlowRoutes(db: Db) {
  const router = Router();
  const coordinator = flowCoordinator(db);
  const issuesSvc = issueService(db);

  router.get("/apex/flows", async (req, res) => {
    assertBoard(req);
    try {
      const flows = await listFlowDefinitions();
      res.json({ flows });
    } catch (err) {
      if (err instanceof ApexUnavailableError) {
        res.status(503).json({ error: err.message, errorType: "apex_unavailable" });
        return;
      }
      if (err instanceof FlowDefinitionError) {
        res.status(502).json({ error: err.message, errorType: err.errorType });
        return;
      }
      throw err;
    }
  });

  router.post("/apex/flows/start", validate(startFlowSchema), async (req, res) => {
    assertBoard(req);
    const { issueId, flowName } = req.body as z.infer<typeof startFlowSchema>;
    const issue = await issuesSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    try {
      const started = await coordinator.startFlow({ issueId, flowName });
      // Advancement continues in the background; a workflow node can run for
      // minutes. Failures inside the loop are classified + surfaced by the
      // coordinator itself — this catch only guards the promise chain.
      void started.execution.catch((err) => {
        logger.error({ err, issueId, flowName }, "flow coordinator: background advancement rejected");
      });
      res.status(202).json({
        issueId: started.issueId,
        flowName: started.flowName,
        flowNodeId: started.flowNodeId,
        flowStatus: started.flowStatus,
      });
    } catch (err) {
      if (err instanceof ApexUnavailableError) {
        res.status(503).json({ error: err.message, errorType: "apex_unavailable" });
        return;
      }
      if (err instanceof FlowDefinitionError) {
        const status = err.errorType === "not_found" ? 404 : 422;
        res.status(status).json({ error: err.message, errorType: err.errorType });
        return;
      }
      throw err;
    }
  });

  router.post("/issues/:issueId/flow/retry", async (req, res) => {
    assertBoard(req);
    const { issueId } = req.params;
    const issue = await issuesSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const result = await coordinator.retryCurrentNode(issueId);
    // Same fire-and-forget shape as /apex/flows/start: advancement continues
    // in the background, failures inside the loop are classified + surfaced
    // by the coordinator itself.
    void result.execution.catch((err) => {
      logger.error({ err, issueId }, "flow coordinator: background retry advancement rejected");
    });
    res.status(202).json({
      issueId: result.issueId,
      flowName: result.flowName,
      flowNodeId: result.flowNodeId,
      flowStatus: result.flowStatus,
    });
  });

  router.post("/issues/:issueId/flow/abandon", async (req, res) => {
    assertBoard(req);
    const { issueId } = req.params;
    const issue = await issuesSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const decidedByUserId = req.actor.type === "board" ? (req.actor.userId ?? null) : null;
    const abandoned = await coordinator.abandonFlow({ issueId, decidedByUserId });
    res.status(200).json({
      issueId: abandoned.id,
      flowName: abandoned.flowName,
      flowNodeId: abandoned.flowNodeId,
      flowStatus: abandoned.flowStatus,
    });
  });

  return router;
}
