import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { upsertUiPreferencesSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { uiPreferenceService } from "../services/index.js";
import { assertBoard } from "./authz.js";

function requireBoardUserId(req: Request, res: Response): string | null {
  assertBoard(req);
  if (!req.actor.userId) {
    res.status(403).json({ error: "Board user context required" });
    return null;
  }
  return req.actor.userId;
}

export function uiPreferenceRoutes(db: Db) {
  const router = Router();
  const svc = uiPreferenceService(db);

  router.get("/ui-preferences/me", async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.getForUser(userId));
  });

  router.put("/ui-preferences/me", validate(upsertUiPreferencesSchema), async (req, res) => {
    const userId = requireBoardUserId(req, res);
    if (!userId) return;
    res.json(await svc.upsertForUser(userId, req.body));
  });

  return router;
}
