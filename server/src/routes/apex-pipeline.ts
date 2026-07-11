/**
 * APEX Tower ticket-lifecycle wiring (apex-tower migration — Task 2 §2).
 *
 * This route adds ONLY the genuinely-new surface the migration calls for; the
 * pipeline itself, its cases, and its gates all live on the fork's existing
 * pipelines/approvals routes + pages (no parallel pipeline surface):
 *
 *   POST /apex/pipeline/seed        — (2a) idempotently seed our fixed Stage
 *                                     machine as pipeline+stages+transitions rows.
 *   POST /apex/pipeline/ingest      — (2c) mirror a repo's open GitHub issues into
 *                                     the seeded pipeline as cases (one per issue).
 *   POST /apex/pipeline/cases/:id/execute
 *                                   — (2d) interim exec dispatch: run the case's
 *                                     APEX workflow (LocalRunner) and advance.
 *
 * The gate:* → approvals bridge (2b) is wired into the approvals route itself
 * (server/src/routes/approvals.ts) — a gate approval's approve/reject there drives
 * the case transition via `resolveGateApproval`.
 */

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { seedApexTowerPipeline } from "../apex/pipeline/seed.js";
import { openGateApprovalIfNeeded } from "../apex/pipeline/gate-bridge.js";
import { IssueIngestionAdapter } from "../apex/pipeline/ingest-service.js";
import { ExecDispatcher } from "../apex/pipeline/exec-dispatch.js";
import { assertBoardOrgAccess, assertCompanyAccess, getActorInfo } from "./authz.js";
import type { PipelineActor } from "../services/pipelines.js";
import type { Request } from "express";

/** Build a pipeline actor from the request (mirrors pipelines.ts actorForMutation). */
function pipelineActor(req: Request): PipelineActor {
  const info = getActorInfo(req);
  if (info.actorType === "agent" && info.agentId && info.runId) {
    return { type: "agent", agentId: info.agentId, runId: info.runId };
  }
  if (info.actorType === "user") {
    return { type: "user", userId: info.actorId };
  }
  return { type: "system" };
}

const seedSchema = z.object({
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
});

const ingestSchema = z.object({
  companyId: z.string().uuid(),
  pipelineId: z.string().uuid(),
  repo: z.string().trim().min(1).max(200), // owner/name
});

const executeSchema = z.object({
  companyId: z.string().uuid(),
});

export function apexPipelineRoutes(db: Db) {
  const router = Router();

  // (2a) Seed the fixed lifecycle pipeline for a company. Idempotent.
  router.post("/apex/pipeline/seed", validate(seedSchema), async (req, res) => {
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, req.body.companyId);
    const result = await seedApexTowerPipeline(db, {
      companyId: req.body.companyId,
      projectId: req.body.projectId ?? null,
      actor: pipelineActor(req),
    });
    res.status(result.created ? 201 : 200).json(result);
  });

  // (2c) Ingest a repo's open GitHub issues as pipeline cases.
  router.post("/apex/pipeline/ingest", validate(ingestSchema), async (req, res) => {
    assertBoardOrgAccess(req);
    assertCompanyAccess(req, req.body.companyId);
    const adapter = new IssueIngestionAdapter(db);
    const result = await adapter.ingestRepo({
      companyId: req.body.companyId,
      pipelineId: req.body.pipelineId,
      repo: req.body.repo,
      actor: pipelineActor(req),
    });
    // Source unavailable (gh missing/unauth) is a 200 with ok:false + note, not a
    // 500 — the sidecar tools are optional (classified, never a crash).
    res.status(result.ok ? 200 : 200).json(result);
  });

  // (2d) Interim exec dispatch for a case sitting on `executing`.
  router.post(
    "/apex/pipeline/cases/:caseId/execute",
    validate(executeSchema),
    async (req, res) => {
      assertBoardOrgAccess(req);
      assertCompanyAccess(req, req.body.companyId);
      const caseId = req.params.caseId as string;
      if (!caseId) throw badRequest("Missing caseId");
      const dispatcher = new ExecDispatcher();
      const result = await dispatcher.dispatchCase(db, {
        companyId: req.body.companyId,
        caseId,
        actor: pipelineActor(req),
      });
      // If execution passed, the case now sits on the pr_review gate — open its
      // approval so the Approvals page surfaces it.
      if (result.ok && result.toStageKey === "pr_review") {
        await openGateApprovalIfNeeded(db, { companyId: req.body.companyId, caseId });
      }
      res.json(result);
    },
  );

  return router;
}
