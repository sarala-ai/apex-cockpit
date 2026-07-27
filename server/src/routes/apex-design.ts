/**
 * Design routes — design-as-code (.penpot, legacy .op) discovery + document reads across a
 * company's bound repos. Read-only; authoring happens in Penpot (later
 * through its gateway-registered MCP), never through these routes.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { listCompanyDesignFiles, fetchDesignFile } from "../design/design-files.js";
import { renderBoard, isUuid } from "../design/penpot-render.js";
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

  // GET /design/board.png?fileId&pageId&boardId[&scale] — renders one board
  // via the live Penpot instance's exporter (ids come from the committed
  // export's summary). 502 when Penpot is unreachable — the UI falls back to
  // the badge summary rather than pretending.
  router.get("/design/board.png", async (req, res) => {
    assertBoardOrAgent(req);
    const fileId = typeof req.query.fileId === "string" ? req.query.fileId : "";
    const pageId = typeof req.query.pageId === "string" ? req.query.pageId : "";
    const boardId = typeof req.query.boardId === "string" ? req.query.boardId : "";
    const scale = Math.min(1, Math.max(0.1, Number(req.query.scale) || 0.35));
    if (![fileId, pageId, boardId].every(isUuid)) {
      res.status(400).json({ error: "fileId, pageId and boardId must be uuids" });
      return;
    }
    try {
      const buf = await renderBoard(fileId, pageId, boardId, scale, "png");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(buf);
    } catch (e) {
      console.error("[design] board.png", e);
      res.status(502).json({ error: "live Penpot render unavailable" });
    }
  });

  // GET /design/board.svg?fileId&pageId&boardId — the board as vector, for
  // inlining into the cockpit's own DOM. Penpot's exporter wraps every shape
  // as <g id="shape-{uuid}">, and those uuids match the committed archive, so
  // the UI can attach its own click navigation (the archive's `nav` map)
  // instead of framing Penpot's viewer.
  router.get("/design/board.svg", async (req, res) => {
    assertBoardOrAgent(req);
    const fileId = typeof req.query.fileId === "string" ? req.query.fileId : "";
    const pageId = typeof req.query.pageId === "string" ? req.query.pageId : "";
    const boardId = typeof req.query.boardId === "string" ? req.query.boardId : "";
    if (![fileId, pageId, boardId].every(isUuid)) {
      res.status(400).json({ error: "fileId, pageId and boardId must be uuids" });
      return;
    }
    try {
      const buf = await renderBoard(fileId, pageId, boardId, 1, "svg");
      // Inlined SVG executes in our origin, so strip anything active before it
      // reaches the DOM — the file is agent-authored, and "we generated it"
      // is not an argument for skipping sanitization.
      const svg = buf
        .toString("utf8")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
        .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
        .replace(/(href|xlink:href)\s*=\s*"\s*javascript:[^"]*"/gi, "");
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "private, max-age=300");
      res.send(svg);
    } catch (e) {
      console.error("[design] board.svg", e);
      res.status(502).json({ error: "live Penpot render unavailable" });
    }
  });

  return router;
}
