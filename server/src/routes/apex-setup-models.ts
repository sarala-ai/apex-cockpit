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
import type { Db } from "@paperclipai/db";
import type { GatewayClient } from "../gateway/gateway-client.js";
import { cockpitSystemGatewayClient } from "../gateway/system-credential.js";
import { assertBoardOrAgent } from "./authz.js";
import {
  readModelAccessState,
  provisionClaudeSubscription,
  provisionClaudeApiKey,
  provisionOpenRouter,
  subscriptionBridgeAvailable,
} from "../apex/model-access/index.js";
import { detectClaudeAuth, detectClaudeAuthForOperator } from "../apex/model-access/detect-claude.js";

export function apexSetupModelsRoutes(db: Db, client: GatewayClient = cockpitSystemGatewayClient()) {
  const router = Router();

  /** GET /setup/models — live snapshot of model access state, claude facts
   *  scoped to the signed-in operator. */
  router.get("/setup/models", async (req, res) => {
    assertBoardOrAgent(req);
    const state = await readModelAccessState(client, detectClaudeAuthForOperator(db, req.actor?.userId ?? null));
    res.json(state);
  });

  /**
   * POST /setup/models/claude/provision — provision the subscription bridge.
   *
   * The bridge spawns `claude -p` on THIS host, so it exists only where the
   * host is the operator's logged-in workstation. Elsewhere it is refused
   * with a classified error rather than registering a bridge URL nothing
   * serves. Returns 428 when claude is not authenticated here, naming the
   * in-UI alternative.
   */
  router.post("/setup/models/claude/provision", async (req, res) => {
    assertBoardOrAgent(req);

    if (!subscriptionBridgeAvailable()) {
      res.status(501).json({
        error: "The subscription bridge is not available on hosted deployments",
        code: "not_available_on_hosted",
        hint: "Complete the 'Connect Claude subscription' step (your per-user session token), or add a Claude API key under Advanced.",
      });
      return;
    }

    const detect = await detectClaudeAuth();
    if (detect.mode === "none" || detect.mode === "unknown") {
      res.status(428).json({
        error: "Claude is not authenticated on the cockpit host",
        code: "claude_session_required",
        hint: "Complete the 'Connect Claude subscription' step in this wizard, or add a Claude API key under Advanced.",
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
