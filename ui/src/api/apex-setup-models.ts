// Setup Models API client — talks to server/src/routes/apex-setup-models.ts.
//
// Provider taxonomy (APEX-115 spec):
//   PROVIDER CLAUDE: subscription (DEFAULT, bridge) | api_key (Advanced)
//   PROVIDER OPENROUTER: api_key only, passthrough openai_compatible row
//   ALIAS LAYER: apex-* aliases seeded by provision, re-pointed by api-key/openrouter

import { api } from "./client";

export interface ProvisionResult {
  ok: true;
  providerName: string;
  aliasesSeeded: string[];
}

export const setupModelsApi = {
  /**
   * GET /setup/models — live ModelAccessState snapshot (probe from gateway +
   * local claude detection). Mirrors setupStateApi but scoped to models only;
   * use when you want to refresh just the models card without re-polling everything.
   */
  state: () =>
    api.get<import("./apex-setup-state").ModelAccessState>("/setup/models"),

  /**
   * POST /setup/models/claude/provision — auto-detect + generate subscription bridge.
   * Returns 428 if claude is not logged in on the host machine.
   */
  provisionSubscription: () =>
    api.post<ProvisionResult>("/setup/models/claude/provision", {}),

  /**
   * POST /setup/models/claude/api-key — Advanced: provision Claude via explicit key.
   * Body: { apiKey }. Re-points all apex-* aliases to the api_key provider.
   */
  provisionApiKey: (apiKey: string) =>
    api.post<ProvisionResult>("/setup/models/claude/api-key", { apiKey }),

  /**
   * POST /setup/models/openrouter — provision OpenRouter as BYO-plane.
   * Body: { apiKey }. Does NOT re-point apex-* aliases (Claude stays primary).
   */
  provisionOpenRouter: (apiKey: string) =>
    api.post<ProvisionResult>("/setup/models/openrouter", { apiKey }),
};
