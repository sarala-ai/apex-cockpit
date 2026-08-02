import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  addReleaseArtifactSchema,
  attachReleaseChangesSchema,
  closeReleaseSchema,
  confoundQuerySchema,
  createReleaseSchema,
  promoteReleaseSchema,
  updateReleaseSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { releaseService } from "../services/releases.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { badRequest } from "../errors.js";

export function releaseRoutes(db: Db) {
  const router = Router();
  const svc = releaseService(db);

  // --- read-only surfaces -------------------------------------------------

  router.get("/companies/:companyId/releases", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  /**
   * The confound question asked directly: "for this product, this window, and
   * optionally this initiative — what else shipped?" Company-scoped because the
   * answer is only meaningful within one product's release stream.
   */
  router.get("/companies/:companyId/releases/confounds", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const parsed = confoundQuerySchema.safeParse({
      windowStart: req.query.windowStart,
      windowEnd: req.query.windowEnd,
      initiativeId: req.query.initiativeId ?? undefined,
    });
    if (!parsed.success) {
      throw badRequest("windowStart and windowEnd are required ISO timestamps");
    }
    res.json(
      await svc.computeConfoundSet({
        companyId,
        windowStart: parsed.data.windowStart,
        windowEnd: parsed.data.windowEnd,
        initiativeId: parsed.data.initiativeId ?? null,
      }),
    );
  });

  router.get("/releases/:id", async (req, res) => {
    const release = await svc.getById(req.params.id as string);
    if (!release) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    assertCompanyAccess(req, release.companyId);
    res.json(await svc.detail(release.id));
  });

  router.get("/releases/:id/notes", async (req, res) => {
    const release = await svc.getById(req.params.id as string);
    if (!release) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    assertCompanyAccess(req, release.companyId);
    res.json(await svc.buildNotes(release.id));
  });

  // --- mutations ----------------------------------------------------------

  router.post(
    "/companies/:companyId/releases",
    validate(createReleaseSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const release = await svc.create(companyId, req.body);
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "release.created",
        entityType: "release",
        entityId: release.id,
        details: { version: release.version, environment: release.environment },
      });
      res.status(201).json(release);
    },
  );

  router.patch("/releases/:id", validate(updateReleaseSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const release = await svc.update(existing.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: release.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "release.updated",
      entityType: "release",
      entityId: release.id,
      details: req.body,
    });
    res.json(release);
  });

  router.post("/releases/:id/promote", validate(promoteReleaseSchema), async (req, res) => {
    const source = await svc.getById(req.params.id as string);
    if (!source) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    assertCompanyAccess(req, source.companyId);
    const promoted = await svc.promote(source.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: promoted.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "release.promoted",
      entityType: "release",
      entityId: promoted.id,
      details: { from: source.id, environment: promoted.environment },
    });
    res.status(201).json(promoted);
  });

  router.post("/releases/:id/close", validate(closeReleaseSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Release not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const release = await svc.close(existing.id, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: release.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "release.closed",
      entityType: "release",
      entityId: release.id,
      details: { closure: release.closure, closureReason: release.closureReason },
    });
    res.json(release);
  });

  router.post(
    "/releases/:id/changes",
    validate(attachReleaseChangesSchema),
    async (req, res) => {
      const existing = await svc.getById(req.params.id as string);
      if (!existing) {
        res.status(404).json({ error: "Release not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      const changes = await svc.attachChanges(existing.id, req.body.issueIds);
      res.status(201).json(changes);
    },
  );

  router.post(
    "/releases/:id/artifacts",
    validate(addReleaseArtifactSchema),
    async (req, res) => {
      const existing = await svc.getById(req.params.id as string);
      if (!existing) {
        res.status(404).json({ error: "Release not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      res.status(201).json(await svc.addArtifact(existing.id, req.body));
    },
  );

  return router;
}
