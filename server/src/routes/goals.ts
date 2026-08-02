import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createGoalSchema,
  updateGoalSchema,
  initiativeFieldsRejectedFor,
} from "@paperclipai/shared";
import { trackGoalCreated } from "@paperclipai/shared/telemetry";
import { validate } from "../middleware/validate.js";
import { goalService, logActivity } from "../services/index.js";
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
