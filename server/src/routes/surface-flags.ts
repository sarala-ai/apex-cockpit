/**
 * Surface-flags REST (the Veil).
 *
 * GET  /orgs/:orgId/surfaces            — registry merged with this org's
 *                                          flags + live due() verdicts.
 * PUT  /orgs/:orgId/surfaces/:surfaceKey — explicit unveil/re-veil. Source is
 *                                          "api" by default, "user" when the
 *                                          request carries X-Paperclip-Ui: 1
 *                                          (the board UI identifies itself),
 *                                          "chat" when the calling agent
 *                                          identifies itself as the chat
 *                                          agent via the same header value.
 * POST /orgs/:orgId/surfaces/reconcile  — apply every due() rule now.
 * GET  /orgs/:orgId/facts               — the raw OrgFacts snapshot.
 */

import { Router } from "express";
import { type Db } from "@paperclipai/db";
import { getSurface, putSurfaceFlagSchema, reconcileSurfaceFlagsSchema } from "@paperclipai/shared";
import { assertBoardOrgAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { notFound } from "../errors.js";
import { computeOrgFacts } from "../services/org-facts.js";
import { surfaceFlagsService } from "../services/surface-flags.js";
import { uiPreferenceService } from "../services/ui-preferences.js";

/** "user" when the board UI identifies itself; "chat" when the header
 *  carries that value instead (set by the chat agent's own calls); "api"
 *  otherwise (an agent or external caller, no UI attribution). */
function resolveSource(req: import("express").Request): "user" | "chat" | "api" {
  const header = req.header("X-Paperclip-Ui");
  if (header === "chat") return "chat";
  if (header === "1" || header === "true") return "user";
  return "api";
}

export function surfaceFlagRoutes(db: Db) {
  const router = Router();
  const flagsSvc = surfaceFlagsService(db);
  const prefsSvc = uiPreferenceService(db);

  router.get<{ orgId: string }>("/orgs/:orgId/surfaces", async (req, res) => {
    assertBoardOrgAccess(req);
    const { orgId } = req.params;
    const facts = await computeOrgFacts(db, { orgId, userId: req.actor.userId ?? null });
    const prefs = req.actor.userId ? await prefsSvc.getForUser(req.actor.userId) : { showAllSurfaces: false };
    const surfaces = await flagsSvc.list(orgId, facts, prefs.showAllSurfaces);
    res.json({ surfaces, facts });
  });

  router.put<{ orgId: string; surfaceKey: string }>("/orgs/:orgId/surfaces/:surfaceKey", validate(putSurfaceFlagSchema), async (req, res) => {
    assertBoardOrgAccess(req);
    const { orgId, surfaceKey } = req.params;
    if (!getSurface(surfaceKey)) {
      throw notFound(`no surface "${surfaceKey}"`);
    }
    const { unveiled, reason } = req.body as { unveiled: boolean; reason: string };
    const flag = await flagsSvc.set(orgId, surfaceKey, {
      unveiled,
      reason,
      source: resolveSource(req),
      actorUserId: req.actor.userId ?? null,
      actorRunId: req.actor.runId ?? null,
    });
    res.json({ flag });
  });

  router.post<{ orgId: string }>("/orgs/:orgId/surfaces/reconcile", validate(reconcileSurfaceFlagsSchema), async (req, res) => {
    assertBoardOrgAccess(req);
    const { orgId } = req.params;
    const facts = await computeOrgFacts(db, { orgId, userId: req.actor.userId ?? null });
    const diff = await flagsSvc.reconcile(orgId, facts);
    res.json({ diff, facts });
  });

  router.get<{ orgId: string }>("/orgs/:orgId/facts", async (req, res) => {
    assertBoardOrgAccess(req);
    const { orgId } = req.params;
    const facts = await computeOrgFacts(db, { orgId, userId: req.actor.userId ?? null });
    res.json({ facts });
  });

  return router;
}
