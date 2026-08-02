import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createGoalSchema,
  updateGoalSchema,
  initiativeFieldsRejectedFor,
  reportCriterionSchema,
  type GoalValidationCriterion,
} from "@paperclipai/shared";
import { trackGoalCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { criterionMonitor, goalService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { getTelemetryClient } from "../telemetry.js";

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);

  router.get("/companies/:companyId/goals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(await svc.withDerivedStatus(result));
  });

  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await svc.getById(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, goal.companyId);
    const [decorated] = await svc.withDerivedStatus([goal]);
    res.json(decorated);
  });

  router.post("/companies/:companyId/goals", validate(createGoalSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const goal = await svc.create(companyId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { title: goal.title },
    });
    const telemetryClient = getTelemetryClient();
    if (telemetryClient) {
      trackGoalCreated(telemetryClient, { goalLevel: goal.level });
    }
    const [decorated] = await svc.withDerivedStatus([goal]);
    res.status(201).json(decorated);
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    // The create schema can check this itself; a PATCH cannot, because the
    // level may not be in the payload. Resolve the level the goal will have
    // after this patch and reject initiative-only fields on anything else.
    const nextLevel = (req.body.level as string | undefined) ?? existing.level;

    // An initiative's status is read from its projects. Accepting a hand-edited
    // one would create a second, competing answer to the same question — the
    // exact drift the derived reading exists to prevent. Closure stays
    // editable: that one IS a human decision.
    if (nextLevel === "initiative" && req.body.status !== undefined) {
      res.status(400).json({
        error:
          "status is derived from an initiative's projects and cannot be set directly; set closure to record how the initiative ended",
      });
      return;
    }

    const rejected = initiativeFieldsRejectedFor(nextLevel, req.body);
    if (rejected.length > 0) {
      res.status(400).json({
        error: `${rejected.join(", ")} ${rejected.length === 1 ? "is" : "are"} only valid on a goal with level "initiative"`,
      });
      return;
    }

    const goal = await svc.update(id, req.body);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.updated",
      entityType: "goal",
      entityId: goal.id,
      details: req.body,
    });

    const [decorated] = await svc.withDerivedStatus([goal]);
    res.json(decorated);
  });

  /**
   * Report against a pre-registered criterion. This is the loop closing — the
   * one thing that never happened across ~40 criteria in 21 specs.
   *
   * It records a verdict, not an evaluation: `measure` and `threshold` are
   * free text, so the reader looks and decides. `missed` is a first-class,
   * unremarkable outcome; a monitor that only ever accepted good news would be
   * the same failure in a new costume.
   */
  router.post(
    "/goals/:id/criteria/:criterionId/report",
    validate(reportCriterionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const criterionId = req.params.criterionId as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      if (existing.level !== "initiative") {
        res.status(400).json({
          error: 'validation criteria are only valid on a goal with level "initiative"',
        });
        return;
      }

      const criteria = (existing.validationCriteria ?? []) as GoalValidationCriterion[];
      const criterion = criteria.find((candidate) => candidate.id === criterionId);
      if (!criterion) {
        res.status(404).json({ error: "Criterion not found" });
        return;
      }
      if (criterion.status === "never_registered") {
        // There is nothing to report against. Allowing a verdict here would
        // turn an honest "nobody wrote one" into a record that one existed.
        res.status(400).json({
          error:
            'a criterion with status "never_registered" cannot be reported against — nothing was registered to measure',
        });
        return;
      }

      const reviewedAt = new Date().toISOString();
      const reported: GoalValidationCriterion = {
        ...criterion,
        status: req.body.status,
        reviewNote: req.body.reviewNote ?? null,
        reviewedAt,
      };
      const goal = await svc.update(id, {
        validationCriteria: criteria.map((candidate) =>
          candidate.id === criterionId ? reported : candidate,
        ),
      });
      if (!goal) {
        res.status(404).json({ error: "Goal not found" });
        return;
      }

      const actor = getActorInfo(req);
      await criterionMonitor(db).closeReviewApprovals(
        id,
        criterionId,
        actor.actorId,
        `criterion reported ${req.body.status}${req.body.reviewNote ? `: ${req.body.reviewNote}` : ""}`,
      );

      await logActivity(db, {
        companyId: goal.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "goal.criterion_reported",
        entityType: "goal",
        entityId: goal.id,
        details: {
          criterionId,
          statement: criterion.statement,
          threshold: criterion.threshold ?? null,
          status: req.body.status,
          reviewNote: req.body.reviewNote ?? null,
          reviewedAt,
        },
      });

      const [decorated] = await svc.withDerivedStatus([goal]);
      res.json(decorated);
    },
  );

  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const goal = await svc.remove(id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: goal.id,
    });

    res.json(goal);
  });

  return router;
}
