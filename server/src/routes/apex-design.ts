/**
 * Design routes — design-as-code (.penpot, legacy .op) discovery + document reads across a
 * company's bound repos. Read-only; authoring happens in OpenPencil (later
 * through its gateway-registered MCP), never through these routes.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { listCompanyDesignFiles, fetchDesignFile } from "../design/design-files.js";
import { assertBoardOrAgent } from "./authz.js";

export function apexDesignRoutes(db: Db) {
  const router = Router();

  // GET /design/files?companyId= — design-file listings per bound repo, failure-isolated.
  router.get("/design/files", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
    try {
      res.json(await listCompanyDesignFiles(db, companyId));
    } catch (e) {
      console.error("[design] files", e);
      res.json([]);
    }
  });

  // GET /design/file?repo=owner/name&path=… — one document (summarized for .penpot).
  router.get("/design/file", async (req, res) => {
    assertBoardOrAgent(req);
    const repo = typeof req.query.repo === "string" ? req.query.repo : "";
    const path = typeof req.query.path === "string" ? req.query.path : "";
    if (!repo || !path) {
      res.status(400).json({ error: "repo and path are required" });
      return;
    }
    const doc = await fetchDesignFile(repo, path);
    if (!doc) {
      res.status(404).json({ error: "design file not found or not readable" });
      return;
    }
    res.json(doc);
  });

  return router;
}
