/**
 * The list behind the count.
 *
 * `GET /companies/:id/sidebar-badges` says HOW MANY things have stopped and
 * the dashboard tile says the same for the whole board. Neither says WHICH,
 * and a number you cannot open is only slightly better than no number: it
 * tells you something is wrong without telling you where to look, which is the
 * gap this whole surface exists to close.
 *
 * Read-only, derived, and not dismissible. See
 * `server/src/apex/pipeline/stopped-steps.ts` for what counts and why.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { listStoppedSteps } from "../apex/pipeline/stopped-steps.js";
import { assertCompanyAccess } from "./authz.js";

export function stoppedStepRoutes(db: Db) {
  const router = Router();

  router.get("/companies/:companyId/stopped-steps", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const steps = await listStoppedSteps(db, companyId);
    const viewerUserId = req.actor.type === "board" ? req.actor.userId ?? null : null;
    res.json({
      items: steps.map((step) => ({
        ...step,
        /**
         * Whether this one is the ASKER's to deal with. Computed here rather
         * than left to the client so "yours" means the same thing on the
         * sidebar count and in the list it opens.
         */
        isMine: viewerUserId != null && step.responsibleUserId === viewerUserId,
      })),
    });
  });

  return router;
}
