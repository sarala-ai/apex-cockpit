import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  activityService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveGateApproval } from "../apex/pipeline/gate-bridge.js";
import { flowCoordinator, FLOW_GATE_APPROVAL_TYPE } from "../apex/flow/coordinator.js";
import { acceptancePullRequestTarget } from "../apex/flow/agent-step.js";
import { ApexUnavailableError, ApexInvocationError, CliApexInvoker, type ApexInvoker } from "../apex/invoke.js";
import type { PipelineActor } from "../services/pipelines.js";

/** Zod contract for github_repo's get_pull_request tool result (apex-core,
 *  the changed-files extension) — see server/src/apex/invoke.ts module doc:
 *  this is the SAME schema the route's response is shaped from, so a CLI
 *  contract drift fails loudly here rather than silently in the UI. */
const PullRequestFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
});
const GetPullRequestResultSchema = z
  .object({
    status: z.string(),
    url: z.string().optional(),
    head_ref: z.string().optional(),
    title: z.string().optional(),
    additions: z.number().optional(),
    deletions: z.number().optional(),
    changed_files: z.number().nullable().optional(),
    files: z.array(PullRequestFileSchema).optional(),
    files_truncated: z.boolean().optional(),
    error: z.string().optional(),
  })
  .passthrough();

/** apex-tower (Task 2 §2b): a pipeline actor from the approving/rejecting board user. */
function gateActor(req: Request): PipelineActor {
  const info = getActorInfo(req);
  if (info.actorType === "agent" && info.agentId && info.runId) {
    return { type: "agent", agentId: info.agentId, runId: info.runId };
  }
  if (info.actorType === "user") {
    return { type: "user", userId: info.actorId };
  }
  return { type: "system" };
}

function redactApprovalPayload<T extends { payload: Record<string, unknown> }>(approval: T): T {
  return {
    ...approval,
    payload: redactEventPayload(approval.payload) ?? {},
  };
}

function isStatusOnlyCheapRecoveryContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.modelProfile === "cheap" &&
    context.recoveryIntent === "status_only" &&
    context.allowDeliverableWork === false &&
    context.allowDocumentUpdates === false &&
    context.resumeRequiresNormalModel === true;
}

export function approvalRoutes(
  db: Db,
  options: { pluginWorkerManager?: PluginWorkerManager; apexInvoker?: ApexInvoker } = {},
) {
  const router = Router();
  const svc = approvalService(db);
  const access = accessService(db);
  const heartbeat = heartbeatService(db, {
    pluginWorkerManager: options.pluginWorkerManager,
  });
  const issueApprovalsSvc = issueApprovalService(db);
  const secretsSvc = secretService(db);
  const strictSecretsMode = process.env.PAPERCLIP_SECRETS_STRICT_MODE === "true";
  const apexInvoker: ApexInvoker = options.apexInvoker ?? new CliApexInvoker();

  async function requireApprovalAccess(req: Request, id: string) {
    const approval = await svc.getById(id);
    if (!approval) {
      return null;
    }
    assertCompanyAccess(req, approval.companyId);
    return approval;
  }

  async function assertApprovalAccessAllowed(req: Request, res: any, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return true;
    res.status(403).json({ error: "Approvals are outside this actor's authorization boundary" });
    return false;
  }

  async function assertApprovalMutationAllowedByRunContext(req: Request, res: any, companyId: string) {
    if (req.actor.type !== "agent") return true;
    const runId = req.actor.runId?.trim();
    if (!runId || !req.actor.agentId) return true;

    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    if (!run || run.companyId !== companyId || run.agentId !== req.actor.agentId) return true;
    if (!isStatusOnlyCheapRecoveryContext(run.contextSnapshot)) return true;

    res.status(403).json({
      error: "Cheap status-only recovery runs cannot create or modify approvals",
      details: {
        companyId,
        runId: run.id,
        modelProfile: "cheap",
        recoveryIntent: "status_only",
        resumeRequiresNormalModel: true,
      },
    });
    return false;
  }

  router.get("/companies/:companyId/approvals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    const status = req.query.status as string | undefined;
    const result = await svc.list(companyId, status);
    res.json(result.map((approval) => redactApprovalPayload(approval)));
  });

  router.get("/approvals/:id", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    res.json(redactApprovalPayload(approval));
  });

  router.post("/companies/:companyId/approvals", validate(createApprovalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!(await assertApprovalAccessAllowed(req, res, companyId))) return;
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, companyId))) return;
    const rawIssueIds = req.body.issueIds;
    const issueIds = Array.isArray(rawIssueIds)
      ? rawIssueIds.filter((value: unknown): value is string => typeof value === "string")
      : [];
    const uniqueIssueIds = Array.from(new Set(issueIds));
    const { issueIds: _issueIds, ...approvalInput } = req.body;
    const normalizedPayload =
      approvalInput.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            companyId,
            approvalInput.payload,
            { strictMode: strictSecretsMode },
          )
        : approvalInput.payload;

    const actor = getActorInfo(req);
    const approval = await svc.create(companyId, {
      ...approvalInput,
      payload: normalizedPayload,
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
      requestedByAgentId:
        approvalInput.requestedByAgentId ?? (actor.actorType === "agent" ? actor.actorId : null),
      status: "pending",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    });

    if (uniqueIssueIds.length > 0) {
      await issueApprovalsSvc.linkManyForApproval(approval.id, uniqueIssueIds, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
    }

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.created",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type, issueIds: uniqueIssueIds },
    });

    res.status(201).json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/issues", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;
    const issues = await issueApprovalsSvc.listIssuesForApproval(id);
    res.json(issues);
  });

  router.post("/approvals/:id/approve", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.approve(id, decidedByUserId, req.body.decisionNote);

    // apex-tower (Task 2 §2b): a gate approval drives our case transition. The
    // `editedBody` (our `edit` decision) is applied as part of the advance.
    if (applied && approval.type === "pipeline_gate") {
      const gate = await resolveGateApproval(db, {
        companyId: approval.companyId,
        payload: approval.payload,
        decision: "approve",
        editedBody: req.body.editedBody ?? null,
        actor: gateActor(req),
      });
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.gate_advanced",
        entityType: "approval",
        entityId: approval.id,
        details: { transitioned: gate.transitioned, toStageKey: gate.toStageKey ?? null, note: gate.note ?? null },
      });
    }

    // Flow coordinator gate hook: an approved flow_gate advances the issue's
    // typed flow past the gate node and resumes deterministic advancement in
    // the background (a subsequent workflow node can run for minutes — never
    // block the decision response on it).
    if (applied && approval.type === FLOW_GATE_APPROVAL_TYPE) {
      const decision = await flowCoordinator(db).onGateDecision({
        approvalId: approval.id,
        payload: approval.payload,
        decision: "approve",
        decidedByUserId: req.actor.userId ?? "board",
      });
      if (decision.resumed) {
        void decision.execution.catch((err) => {
          logger.error(
            { err, approvalId: approval.id },
            "flow coordinator: background advancement after gate approval rejected",
          );
        });
      }
    }

    if (applied) {
      const linkedIssues = await issueApprovalsSvc.listIssuesForApproval(approval.id);
      const linkedIssueIds = linkedIssues.map((issue) => issue.id);
      const primaryIssueId = linkedIssueIds[0] ?? null;

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.approved",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          requestedByAgentId: approval.requestedByAgentId,
          linkedIssueIds,
        },
      });

      if (approval.requestedByAgentId) {
        try {
          const wakeRun = await heartbeat.wakeup(approval.requestedByAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "approval_approved",
            payload: {
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
            },
            requestedByActorType: "user",
            requestedByActorId: req.actor.userId ?? "board",
            contextSnapshot: {
              source: "approval.approved",
              approvalId: approval.id,
              approvalStatus: approval.status,
              issueId: primaryIssueId,
              issueIds: linkedIssueIds,
              taskId: primaryIssueId,
              wakeReason: "approval_approved",
            },
          });

          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_queued",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              wakeRunId: wakeRun?.id ?? null,
              linkedIssueIds,
            },
          });
        } catch (err) {
          logger.warn(
            {
              err,
              approvalId: approval.id,
              requestedByAgentId: approval.requestedByAgentId,
            },
            "failed to queue requester wakeup after approval",
          );
          await logActivity(db, {
            companyId: approval.companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "approval.requester_wakeup_failed",
            entityType: "approval",
            entityId: approval.id,
            details: {
              requesterAgentId: approval.requestedByAgentId,
              linkedIssueIds,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post("/approvals/:id/reject", validate(resolveApprovalSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    if (!(await requireApprovalAccess(req, id))) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    const decidedByUserId = req.actor.userId ?? "board";
    const { approval, applied } = await svc.reject(id, decidedByUserId, req.body.decisionNote);

    // apex-tower (Task 2 §2b): a rejected gate moves the case to `failed`.
    if (applied && approval.type === "pipeline_gate") {
      const gate = await resolveGateApproval(db, {
        companyId: approval.companyId,
        payload: approval.payload,
        decision: "reject",
        actor: gateActor(req),
      });
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.gate_rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { transitioned: gate.transitioned, toStageKey: gate.toStageKey ?? null, note: gate.note ?? null },
      });
    }

    // Flow coordinator gate hook: a rejected flow_gate pauses the flow and
    // surfaces it (rejection is a new decision point, not a retry loop).
    if (applied && approval.type === FLOW_GATE_APPROVAL_TYPE) {
      await flowCoordinator(db).onGateDecision({
        approvalId: approval.id,
        payload: approval.payload,
        decision: "reject",
        decidedByUserId: req.actor.userId ?? "board",
      });
    }

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });
    }

    res.json(redactApprovalPayload(approval));
  });

  router.post(
    "/approvals/:id/request-revision",
    validate(requestApprovalRevisionSchema),
    async (req, res) => {
      assertBoard(req);
      const id = req.params.id as string;
      if (!(await requireApprovalAccess(req, id))) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      const decidedByUserId = req.actor.userId ?? "board";
      const approval = await svc.requestRevision(id, decidedByUserId, req.body.decisionNote);

      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.revision_requested",
        entityType: "approval",
        entityId: approval.id,
        details: { type: approval.type },
      });

      res.json(redactApprovalPayload(approval));
    },
  );

  router.post("/approvals/:id/resubmit", validate(resubmitApprovalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, existing.companyId))) return;

    if (req.actor.type === "agent" && req.actor.agentId !== existing.requestedByAgentId) {
      res.status(403).json({ error: "Only requesting agent can resubmit this approval" });
      return;
    }

    const normalizedPayload = req.body.payload
      ? existing.type === "hire_agent"
        ? await secretsSvc.normalizeHireApprovalPayloadForPersistence(
            existing.companyId,
            req.body.payload,
            { strictMode: strictSecretsMode },
          )
        : req.body.payload
      : undefined;
    const approval = await svc.resubmit(id, normalizedPayload);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.resubmitted",
      entityType: "approval",
      entityId: approval.id,
      details: { type: approval.type },
    });
    res.json(redactApprovalPayload(approval));
  });

  router.get("/approvals/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    const comments = await svc.listComments(id);
    res.json(comments);
  });

  router.post("/approvals/:id/comments", validate(addApprovalCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalMutationAllowedByRunContext(req, res, approval.companyId))) return;
    const actor = getActorInfo(req);
    const comment = await svc.addComment(id, req.body.body, {
      agentId: actor.agentId ?? undefined,
      userId: actor.actorType === "user" ? actor.actorId : undefined,
    });

    await logActivity(db, {
      companyId: approval.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "approval.comment_added",
      entityType: "approval",
      entityId: approval.id,
      details: { commentId: comment.id },
    });

    res.status(201).json(comment);
  });

  /**
   * Read-only PR-diff summary for a flow_gate approval — fetched at VIEW
   * time from the PR head (never frozen into the approval payload), so an
   * already-pending approval benefits the moment this ships. Resolves the
   * `pr_exists:<repo>#<head>` acceptance declaration the flow coordinator
   * recorded on the issue's activity log for the A-node that fed this gate
   * (same parsing agent-step.ts's evaluator uses — not duplicated here),
   * then asks apex-core's github_repo.get_pull_request for the current
   * file list. Every failure mode (no PR target found, apex CLI missing,
   * gh failure) degrades to a structured JSON response — never a 500.
   */
  router.get("/approvals/:id/pr-diff", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);

    if (approval.type !== FLOW_GATE_APPROVAL_TYPE) {
      res.json({ available: false, reason: "not_a_flow_gate_approval" });
      return;
    }
    const payload = approval.payload as Record<string, unknown>;
    const issueId = typeof payload.issueId === "string" ? payload.issueId : null;
    if (!issueId) {
      res.json({ available: false, reason: "approval payload missing issueId" });
      return;
    }

    // Walk the issue's activity log (newest first) for the most recent
    // agent-step acceptance that declared a pr_exists target.
    const activityRows = await activityService(db).forIssue(issueId);
    let prTarget: { repo: string; head: string } | null = null;
    let acceptanceEvaluation: string | null = null;
    for (const row of activityRows) {
      const details = (row.details ?? {}) as Record<string, unknown>;
      const acceptance = typeof details.acceptance === "string" ? details.acceptance : null;
      if (!acceptance) continue;
      const target = acceptancePullRequestTarget(acceptance);
      if (target) {
        prTarget = target;
        acceptanceEvaluation =
          typeof details.acceptanceEvaluation === "string" ? details.acceptanceEvaluation : null;
        break;
      }
    }
    if (!prTarget) {
      res.json({ available: false, reason: "no pr_exists acceptance found for this issue" });
      return;
    }

    try {
      const result = await apexInvoker.invoke(
        "github_repo",
        "get_pull_request",
        { repo: prTarget.repo, head: prTarget.head },
        GetPullRequestResultSchema,
      );
      if (result.status !== "success") {
        res.json({
          available: true,
          degraded: true,
          repo: prTarget.repo,
          headBranch: prTarget.head,
          error: result.error ?? `get-pull-request reported status '${result.status}'`,
          acceptanceEvaluation,
        });
        return;
      }
      res.json({
        available: true,
        degraded: false,
        repo: prTarget.repo,
        headBranch: result.head_ref ?? prTarget.head,
        url: result.url ?? "",
        title: result.title ?? "",
        totals: {
          additions: result.additions ?? 0,
          deletions: result.deletions ?? 0,
          changedFiles: result.changed_files ?? result.files?.length ?? 0,
        },
        files: result.files ?? [],
        files_truncated: result.files_truncated ?? false,
        acceptanceEvaluation,
      });
    } catch (err) {
      if (err instanceof ApexUnavailableError || err instanceof ApexInvocationError) {
        res.json({
          available: true,
          degraded: true,
          repo: prTarget.repo,
          headBranch: prTarget.head,
          error: err.message,
          acceptanceEvaluation,
        });
        return;
      }
      throw err;
    }
  });

  return router;
}
