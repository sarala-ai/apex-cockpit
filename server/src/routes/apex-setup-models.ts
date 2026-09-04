/**
 * Setup Models routes — the API surface for the setup wizard's "Models" step.
 *
 * Two provider cards (spec comment 5668607e, founder-settled taxonomy):
 *
 *   GET  /setup/models          — read current ModelAccessState (live probe)
 *   POST /setup/models/claude/provision   — subscription auto-detect + generate
 *   POST /setup/models/claude/api-key     — Claude api_key mode (Advanced)
 *   POST /setup/models/openrouter         — OpenRouter BYO-plane key
 *
 * All write routes are idempotent: safe to call repeatedly if the UI re-runs
 * setup. Gateway conflicts (409) are treated as "already done", not errors.
 */

import { Router } from "express";
import type { GatewayClient } from "../gateway/gateway-client.js";
import { cockpitSystemGatewayClient } from "../gateway/system-credential.js";
import { assertBoardOrAgent } from "./authz.js";
import {
  readModelAccessState,
  provisionClaudeSubscription,
  provisionClaudeApiKey,
  provisionOpenRouter,
} from "../apex/model-access/index.js";
import { detectClaudeAuth } from "../apex/model-access/detect-claude.js";

export function apexSetupModelsRoutes(client: GatewayClient = cockpitSystemGatewayClient()) {
  const router = Router();

  /** GET /setup/models — live snapshot of model access state. */
  router.get("/setup/models", async (req, res) => {
    assertBoardOrAgent(req);
    const state = await readModelAccessState(client);
    res.json(state);
  });

  /**
   * POST /setup/models/claude/provision — provision the subscription bridge.
   *
   * Auto-detect: if the local claude CLI is logged in, generate the bridge
   * provider row + apex-* aliases. Returns 428 if claude is not detected so
   * the UI can guide the operator.
   */
  router.post("/setup/models/claude/provision", async (req, res) => {
    assertBoardOrAgent(req);

    const detect = await detectClaudeAuth();
    if (detect.mode === "none") {
      res.status(428).json({
        error: "Claude is not authenticated on this machine",
        hint: "Run `claude login` or set ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN",
        detected: detect,
      });
      return;
    }
    if (detect.mode === "api_key") {
      res.status(428).json({
        error: "ANTHROPIC_API_KEY is set — use the api-key endpoint instead of provision",
        detected: detect,
      });
      return;
    }

    const result = await provisionClaudeSubscription(client);
    if (!result.ok) {
      res.status(502).json({ error: result.reason });
      return;
    }
    const { ok: _ok1, ...rest1 } = result;
    res.json({ ok: true, ...rest1 });
  });

  /**
   * POST /setup/models/claude/api-key — provision Claude via explicit API key.
   * Body: { apiKey: string }
   *
   * The key is forwarded ONLY to the gateway's encrypted store; the cockpit
   * never persists it. This re-points all apex-* aliases to the api_key
   * provider (which enables per-token cost attribution).
   */
  router.post("/setup/models/claude/api-key", async (req, res) => {
    assertBoardOrAgent(req);
    const { apiKey } = (req.body ?? {}) as { apiKey?: unknown };
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }

    const result = await provisionClaudeApiKey(apiKey.trim(), client);
    if (!result.ok) {
      res.status(502).json({ error: result.reason });
      return;
    }
    const { ok: _ok2, ...rest2 } = result;
    res.json({ ok: true, ...rest2 });
  });

  /**
   * POST /setup/models/openrouter — provision OpenRouter as BYO-plane.
   * Body: { apiKey: string }
   *
   * Creates a standard openai_compatible provider row + key in the gateway.
   * Existing apex-* alias routing is unchanged (Claude subscription stays
   * primary). This is the non-Claude-models answer and the first live
   * BYO-plane proof.
   */
  router.post("/setup/models/openrouter", async (req, res) => {
    assertBoardOrAgent(req);
    const { apiKey } = (req.body ?? {}) as { apiKey?: unknown };
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      res.status(400).json({ error: "apiKey is required" });
      return;
    }

    const result = await provisionOpenRouter(apiKey.trim(), client);
    if (!result.ok) {
      res.status(502).json({ error: result.reason });
      return;
    }
    const { ok: _ok3, ...rest3 } = result;
    res.json({ ok: true, ...rest3 });
  });

  return router;
}
