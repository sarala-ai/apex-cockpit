import express, { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  GOAL_LEVELS,
  createGoalSchema,
  updateGoalSchema,
  initiativeFieldsRejectedFor,
  reportCriterionSchema,
  type GoalValidationCriterion,
} from "@paperclipai/shared";
import {
  IMPORT_NOTES,
  buildGoalCsv,
  formatProjects,
  parseGoalCsv,
  planRow,
  summarise,
  type ExistingInitiative,
  type ImportRowResult,
} from "../services/goal-csv.js";
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

  /**
   * EXPORT — the live set, as a sheet, for offline scanning.
   *
   * This is not the review path (that is a proposal's grid, which shows
   * provenance per row and gates corrections). It is the "read 26 rows at once
   * somewhere else" path, which is a real and separate need.
   *
   * Row order is `created_at` so two exports taken minutes apart diff to
   * nothing, and the document carries a BOM because Excel silently mangles
   * UTF-8 without one — an initiative title with a "₹" in it would otherwise
   * arrive as mojibake and get "corrected" by a reviewer.
   */
  router.get("/companies/:companyId/goals/export.csv", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const level = typeof req.query.level === "string" ? req.query.level : null;
    if (level && !(GOAL_LEVELS as readonly string[]).includes(level)) {
      res.status(400).json({ error: `level must be one of ${GOAL_LEVELS.join(", ")}` });
      return;
    }

    const all = await svc.list(companyId);
    const selected = (level ? all.filter((goal) => goal.level === level) : all).sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
        a.id.localeCompare(b.id),
    );
    const decorated = await svc.withDerivedStatus(selected);
    const projectsByGoal = await svc.projectSummariesByGoal(decorated.map((goal) => goal.id));

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${level ?? "goals"}-${companyId}.csv"`,
    );
    res.send(buildGoalCsv(decorated as never, projectsByGoal));
  });

  /**
   * IMPORT — the secondary, bulk-edit path. See the header of
   * `services/goal-csv.ts` for why it is secondary and why blank means
   * unchanged.
   *
   * Dry-run by default; `?apply=true` writes. Row errors are reported with
   * their file line number and never abort the batch, because the alternative
   * is a human re-uploading twenty-six rows to fix three.
   */
  router.post(
    "/companies/:companyId/goals/import.csv",
    express.text({ type: ["text/csv", "text/plain", "application/csv"], limit: "5mb" }),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body =
        typeof req.body === "string"
          ? req.body
          : typeof (req.body as { csv?: unknown } | undefined)?.csv === "string"
            ? ((req.body as { csv: string }).csv)
            : null;
      if (body === null) {
        res.status(400).json({
          error: 'Send the sheet as text/csv, or as JSON {"csv": "..."}.',
        });
        return;
      }

      const apply = req.query.apply === "true";
      const { rows, notes } = parseGoalCsv(body);

      // Company-scoped up front: an id from another company must resolve to
      // "no such initiative here", never to a cross-tenant write.
      const existingGoals = await svc.list(companyId);
      const decorated = await svc.withDerivedStatus(existingGoals);
      const projectsByGoal = await svc.projectSummariesByGoal(decorated.map((goal) => goal.id));
      const byId = new Map(decorated.map((goal) => [goal.id, goal]));

      const results: ImportRowResult[] = [];
      for (const parsed of rows) {
        const id = (parsed.cells.get("id") ?? "").trim();
        const found = id ? byId.get(id) ?? null : null;
        if (id && found && found.level !== "initiative") {
          results.push({
            row: parsed.row,
            id,
            action: "error",
            changes: [],
            notices: [],
            error: `Goal ${id} is a "${found.level}" goal, not an initiative.`,
          });
          continue;
        }
        const projectsCell = found ? formatProjects(projectsByGoal.get(found.id) ?? []) : null;
        const { result, patch } = planRow(
          parsed,
          (found as ExistingInitiative | null) ?? null,
          projectsCell,
        );

        if (apply && patch) {
          try {
            if (result.action === "create") {
              const created = await svc.create(companyId, {
                ...patch,
                title: patch.title as string,
                level: "initiative",
              } as never);
              result.id = created.id;
            } else if (result.action === "update" && found) {
              await svc.update(found.id, patch as never);
            }
          } catch (err) {
            results.push({
              ...result,
              action: "error",
              error: err instanceof Error ? err.message : String(err),
            });
            continue;
          }
        }
        results.push(result);
      }

      const summary = summarise(results, apply);
      if (apply && (summary.created > 0 || summary.updated > 0)) {
        // A bulk write leaves a trail. Twenty-six rows changed by one upload is
        // exactly the kind of edit someone will need to reconstruct later.
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          action: "goal.csv_imported",
          entityType: "company",
          entityId: companyId,
          details: {
            created: summary.created,
            updated: summary.updated,
            unchanged: summary.unchanged,
            errors: summary.errors,
          },
        });
      }

      res.json({
        ...summary,
        results,
        notes: [
          ...notes,
          IMPORT_NOTES.blankVsClear,
          IMPORT_NOTES.derivedStatusReadOnly,
          IMPORT_NOTES.projectsReadOnly,
          apply
            ? "Applied."
            : "Dry run — nothing was written. Re-send with ?apply=true to apply these changes.",
        ],
      });
    },
  );

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
