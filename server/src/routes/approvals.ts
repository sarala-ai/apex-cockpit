import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import { agents as agentsTable, heartbeatRuns, type Db } from "@paperclipai/db";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
  resubmitApprovalSchema,
  PROPOSAL_APPROVAL_TYPE,
} from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { badRequest } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  approvalService,
  accessService,
  activityService,
  heartbeatService,
  issueApprovalService,
  logActivity,
  proposalService,
  secretService,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { redactEventPayload } from "../redaction.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import { resolveGateApproval } from "../apex/pipeline/gate-bridge.js";
import { flowCoordinator, FLOW_GATE_APPROVAL_TYPE } from "../apex/flow/coordinator.js";
import { CliApexInvoker, type ApexInvoker } from "../apex/invoke.js";
import {
  assembleFlowGateBrief,
  fetchPullRequestSummary,
  findAcceptanceTarget,
  type ProvenanceLookup,
} from "../apex/steps/brief.js";
import type { DesignArchiveFetcher } from "../apex/steps/design-artifact.js";
import { fetchDesignArchive } from "../design/design-files.js";
import { loadProcessDefinitionByKey, pipelineService, type PipelineActor } from "../services/pipelines.js";
import type { ProcessDefinition } from "../apex/steps/process-definition.js";

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

/**
 * Fold the approver's ticked review passes into an activity-log detail —
 * only when something was ticked, so an untouched checklist leaves no trace
 * that could be mistaken for "reviewed and found nothing"
 * (docs/architecture/review-passes.md).
 *
 * The activity log is where this belongs rather than a new column on
 * `approvals`: it is the decision ledger the GitHub projection already
 * mirrors, and an acknowledgement nobody has yet proven useful does not earn
 * a schema migration.
 */
function acknowledgedReviewPassDetails(value: unknown): { acknowledgedReviewPasses?: string[] } {
  if (!Array.isArray(value)) return {};
  const ids = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return ids.length > 0 ? { acknowledgedReviewPasses: ids.map((v) => v.trim()) } : {};
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

/** Default provenance reader for the decision brief: the commissioned run's
 *  permission stamp (heartbeat_runs.permissionMode/permissionProfile, written
 *  by the flow coordinator) plus the agent's display name — so the brief can
 *  say "Designer, bounded profile" instead of a bare UUID. Best-effort: any
 *  failure leaves the ids in place and the brief still answers the decision. */
function dbProvenanceLookup(db: Db): ProvenanceLookup {
  return async ({ agentId, runId }) => {
    const [agentRow, runRow] = await Promise.all([
      agentId
        ? db
            .select({ name: agentsTable.name })
            .from(agentsTable)
            .where(eq(agentsTable.id, agentId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
      runId
        ? db
            .select({
              permissionMode: heartbeatRuns.permissionMode,
              permissionProfile: heartbeatRuns.permissionProfile,
            })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, runId))
            .then((rows) => rows[0] ?? null)
        : Promise.resolve(null),
    ]);
    return {
      agentName: agentRow?.name ?? null,
      permissionProfile: runRow?.permissionProfile ?? null,
      permissionMode: runRow?.permissionMode ?? null,
    };
  };
}

export function approvalRoutes(
  db: Db,
  options: {
    pluginWorkerManager?: PluginWorkerManager;
    apexInvoker?: ApexInvoker;
    /** Injected by tests so the brief's definition-derived "what happens
     *  next" can be exercised without seeding a whole pipeline. Production
     *  reads the definition out of the database — the process definition is a
     *  DB object now, not a git file behind a CLI. */
    loadProcessDefinition?: (companyId: string, name: string) => Promise<ProcessDefinition | null>;
    provenanceLookup?: ProvenanceLookup;
    /** Injected by tests so the design preview can be exercised without gh.
     *  Defaults to the real `gh`-backed archive read. */
    fetchDesignArchive?: DesignArchiveFetcher;
  } = {},
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
  const processDefinitionLoader =
    options.loadProcessDefinition ??
    ((companyId: string, name: string) => loadProcessDefinitionByKey(db, companyId, name));
  const provenanceLookup: ProvenanceLookup = options.provenanceLookup ?? dbProvenanceLookup(db);


  /**
   * Route a decided gate to whichever host owns it.
   *
   * A gate approval carrying a `caseId` belongs to a PIPELINE CASE; one
   * carrying only the issue/flow keys belongs to the flow front-end. Both
   * share the `flow_gate` type, so the dispatch is on the PAYLOAD — which
   * keeps one approval type, one brief and one UI across both hosts while the
   * front-end is still standing, instead of forking the surface a reviewer
   * sees to match an internal migration.
   *
   * Returns true when the pipeline host handled it. Failures are surfaced, not
   * swallowed: a decision that did not move the work is exactly the thing a
   * reviewer must not be told succeeded.
   */
  async function routeGateDecisionToCase(
    payload: Record<string, unknown>,
    decision: "approve" | "reject" | "request_changes",
    actor: PipelineActor,
    reason: string | null,
  ): Promise<boolean> {
    if (typeof payload.caseId !== "string") return false;
    const result = await pipelineService(db).decideStageGate({ payload, decision, reason, actor });
    return result !== null;
  }

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

    // PROPOSAL gate hook: approval is what MATERIALISES the proposed records.
    // Nothing existed on the board until this line ran — that is the whole
    // contract of a proposal, and it is why corrections are safe to make
    // roughly and fast while it is still in review.
    if (applied && approval.type === PROPOSAL_APPROVAL_TYPE) {
      const materialized = await proposalService(db).onApprovalDecision(approval.id, "approve");
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "proposal.materialized",
        entityType: "proposal",
        entityId: materialized?.id ?? approval.id,
        details: {
          approvalId: approval.id,
          created: materialized?.materialization?.created.length ?? 0,
          updated: materialized?.materialization?.updated.length ?? 0,
          skipped: materialized?.materialization?.skipped.length ?? 0,
          errors: materialized?.materialization?.errors ?? [],
        },
      });
    }

    // Flow coordinator gate hook: an approved flow_gate advances the issue's
    // typed flow past the gate node and resumes deterministic advancement in
    // the background (a subsequent workflow node can run for minutes — never
    // block the decision response on it).
    if (applied && approval.type === FLOW_GATE_APPROVAL_TYPE) {
      const handledByCase = await routeGateDecisionToCase(
        approval.payload,
        "approve",
        { type: "user", userId: req.actor.userId ?? "board" },
        null,
      );
      const decision = handledByCase
        ? { resumed: false as const, execution: Promise.resolve() }
        : await flowCoordinator(db).onGateDecision({
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
          ...acknowledgedReviewPassDetails(req.body.acknowledgedReviewPasses),
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
    const existing = await requireApprovalAccess(req, id);
    if (!existing) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    // A flow gate is a review stage, and a review stage requires a reason for
    // any non-approve decision — exactly what a pipeline review stage's
    // `requireRejectReason` enforces (services/pipelines.ts `reviewCase`).
    // Classified at the door, before the approval is resolved, so a reasonless
    // decision never becomes a decided-but-unexplained ledger entry.
    const reviewerNote =
      typeof req.body.decisionNote === "string" ? req.body.decisionNote.trim() : "";
    if (existing.type === FLOW_GATE_APPROVAL_TYPE && reviewerNote.length === 0) {
      throw badRequest(
        "Rejecting a flow gate requires a decision note explaining why the work should not proceed.",
        { errorType: "gate_review_reason_required", decision: "reject", approvalId: id },
      );
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

    // A rejected proposal materialises nothing and keeps its records as the
    // evidence of what was proposed and turned down.
    if (applied && approval.type === PROPOSAL_APPROVAL_TYPE) {
      await proposalService(db).onApprovalDecision(approval.id, "reject");
    }

    // Flow coordinator gate hook: a rejected flow_gate STOPS the flow (paused).
    // Rejection means the work should not proceed at all; sending it back for
    // another round is the separate `request_changes` decision, which rides
    // POST /approvals/:id/request-revision.
    if (applied && approval.type === FLOW_GATE_APPROVAL_TYPE) {
      const handledByCase = await routeGateDecisionToCase(
        approval.payload,
        "reject",
        { type: "user", userId: req.actor.userId ?? "board" },
        req.body.decisionNote ?? null,
      );
      if (!handledByCase) {
        await flowCoordinator(db).onGateDecision({
          approvalId: approval.id,
          payload: approval.payload,
          decision: "reject",
          decidedByUserId: req.actor.userId ?? "board",
          reason: req.body.decisionNote ?? null,
        });
      }
    }

    if (applied) {
      await logActivity(db, {
        companyId: approval.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "approval.rejected",
        entityType: "approval",
        entityId: approval.id,
        details: {
          type: approval.type,
          ...acknowledgedReviewPassDetails(req.body.acknowledgedReviewPasses),
        },
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
      const existing = await requireApprovalAccess(req, id);
      if (!existing) {
        res.status(404).json({ error: "Approval not found" });
        return;
      }
      // On a flow gate this route IS the `request_changes` decision (the fork's
      // existing "redo with feedback" verb on an approval). The reason is
      // required the way a pipeline review stage's `requireRequestChangesReason`
      // requires it, because the reason is the whole instruction: it is
      // delivered verbatim to the step that redoes the work.
      const reviewerNote =
        typeof req.body.decisionNote === "string" ? req.body.decisionNote.trim() : "";
      if (existing.type === FLOW_GATE_APPROVAL_TYPE && reviewerNote.length === 0) {
        throw badRequest(
          "Requesting changes at a flow gate requires a reason: it is delivered verbatim to the step that redoes the work.",
          { errorType: "gate_review_reason_required", decision: "request_changes", approvalId: id },
        );
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

      // Request-changes on a proposal: the records go back to the proposing
      // agent WITH the reasons attached — which is the existing approval
      // routing (decision note + requester wakeup), reused rather than rebuilt.
      if (approval.type === PROPOSAL_APPROVAL_TYPE) {
        await proposalService(db).onApprovalDecision(approval.id, "request_changes");
      }

      // Route the decision into the flow: the work goes back to the gate's
      // change-request target and the flow resumes in the background (the
      // re-commissioned agent step can take minutes — never block the
      // decision response on it).
      if (approval.type === FLOW_GATE_APPROVAL_TYPE) {
        const handledByCase = await routeGateDecisionToCase(
          approval.payload,
          "request_changes",
          { type: "user", userId: decidedByUserId },
          req.body.decisionNote ?? null,
        );
        const decision = handledByCase
          ? { resumed: false as const, execution: Promise.resolve() }
          : await flowCoordinator(db).onGateDecision({
          approvalId: approval.id,
          payload: approval.payload,
          decision: "request_changes",
          decidedByUserId,
          reason: req.body.decisionNote ?? null,
        });
        if (decision.resumed) {
          void decision.execution.catch((err) => {
            logger.error(
              { err, approvalId: approval.id },
              "flow coordinator: background advancement after request_changes rejected",
            );
          });
        }
      }

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
    // The proposing agent has answered the change request; the proposal is back
    // in front of the reviewer, not silently re-approved.
    if (approval.type === PROPOSAL_APPROVAL_TYPE) {
      const proposal = await proposalService(db).getByApprovalId(approval.id);
      if (proposal && proposal.status === "changes_requested") {
        await proposalService(db).update(proposal.id, { status: "in_review" });
      }
    }
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
    const target = findAcceptanceTarget(activityRows);
    if (!target) {
      res.json({ available: false, reason: "no pr_exists acceptance found for this issue" });
      return;
    }

    // Unchanged wire shape for existing consumers — the helper carries
    // acceptanceEvaluation through on both the healthy and degraded branch.
    res.json(await fetchPullRequestSummary(apexInvoker, target));
  });

  /**
   * DECISION BRIEF for a flow_gate approval — the founder-facing answer to
   * "what am I deciding, what was already verified, what should I look at,
   * what happens if I approve or reject, and who did the work".
   *
   * Why a brief and not the log (founder critique): a flow-gated ticket today
   * reads as agent slop — instruction comments, wake fences, status
   * transitions and raw acceptance strings — and "I don't know what to
   * interpret, where to start and where to end." Machine strings are still
   * returned, but only under `verified.machine` / `machine`, never as a
   * headline.
   *
   * "What happens next" is DERIVED: the flow definition is loaded through
   * `apex flows show` and the node(s) AFTER this gate are described, so the
   * sentence tracks the flow YAML instead of a hardcoded string.
   *
   * Failure-isolated exactly like the pr-diff route it shares helpers with:
   * a missing apex CLI, a gh failure, an unloadable flow definition or a
   * failed provenance lookup each degrade a section — never a 500.
   */
  router.get("/approvals/:id/brief", async (req, res) => {
    const id = req.params.id as string;
    const approval = await svc.getById(id);
    if (!approval) {
      res.status(404).json({ error: "Approval not found" });
      return;
    }
    assertCompanyAccess(req, approval.companyId);
    if (!(await assertApprovalAccessAllowed(req, res, approval.companyId))) return;

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

    const activityRows = await activityService(db).forIssue(issueId);
    const brief = await assembleFlowGateBrief({
      approvalId: approval.id,
      payload,
      activityRows,
      apexInvoker,
      loadProcessDefinition: (name: string) => processDefinitionLoader(approval.companyId, name),
      provenanceLookup,
      fetchDesignArchive: options.fetchDesignArchive ?? fetchDesignArchive,
    });
    res.json(brief);
  });

  return router;
}
