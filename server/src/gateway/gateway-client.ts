/**
 * GatewayClient — thin read-only client for apex-gateway (ContextForge fork),
 * following the exact fetch+bearer pattern already proven in
 * routes/apex-setup-state.ts (`gatewayUrl()` + `APEX_GATEWAY_TOKEN` + a timed,
 * abortable fetch). Every method narrows the gateway's response to an explicit
 * safe field pick (see @paperclipai/shared/gateway) — never forwards raw
 * payloads, so auth_value/auth_headers/oauth_config and similar secret-bearing
 * fields can't leak to the browser even if the gateway's schema grows a new one.
 *
 * Failure-isolated: every method returns an empty/null result on any failure
 * (unreachable gateway, missing token, non-2xx) rather than throwing, so a down
 * gateway degrades the Gateway page/Observe metrics to empty state, never a 500.
 */
import type {
  GatewayEntry,
  GatewayToolEntry,
  GatewayServerEntry,
  GatewayAgentEntry,
  GatewayAuditEntry,
  GatewayMetrics,
  GatewayPromptEntry,
} from "@paperclipai/shared";

const gatewayUrl = (): string =>
  (process.env.APEX_GATEWAY_URL ?? "http://127.0.0.1:4444").replace(/\/$/, "");

async function timedFetch(url: string, timeoutMs = 5000): Promise<Response | null> {
  const token = process.env.APEX_GATEWAY_TOKEN;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Write-path result shape for register/delete — deliberately NOT
 * failure-isolated like the read methods above (empty-on-failure would hide a
 * write outcome from the caller). Every branch is explicit: `ok` carries the
 * gateway's own id/name back so the route can report what was created;
 * `status` classifies the failure so the route (and ultimately the UI) can
 * give an actionable message instead of a raw upstream string.
 */
export type GatewayWriteResult =
  | { ok: true; id: string | null; name: string }
  | {
      ok: false;
      // "unreachable" = we couldn't even reach apex-gateway itself (network/timeout).
      // "upstream_unreachable" = apex-gateway is up but couldn't connect to the
      // registered URL (its 502) — a different, more actionable failure.
      status: "conflict" | "validation" | "unreachable" | "upstream_unreachable" | "error";
      message: string;
    };

function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const m = (body as Record<string, unknown>).message ?? (body as Record<string, unknown>).detail;
    if (typeof m === "string" && m.trim()) return m;
  }
  return fallback;
}

async function timedWrite(
  url: string,
  init: RequestInit,
  timeoutMs = 8000,
): Promise<{ status: number; body: unknown } | null> {
  const token = process.env.APEX_GATEWAY_TOKEN;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export class GatewayClient {
  async reachable(): Promise<boolean> {
    return (await timedFetch(`${gatewayUrl()}/health`)) !== null;
  }

  // NOTE: gateways/tools/a2a/servers all extend ContextForge's
  // BaseModelWithConfigDict, which auto-converts snake_case Python field
  // names to camelCase on JSON serialization (verified against a live
  // instance) — read camelCase here, NOT the Python attribute names.
  // AuditTrailResponse below is a plain BaseModel (no such conversion),
  // confirmed to stay snake_case.
  async listGateways(): Promise<GatewayEntry[]> {
    const res = await timedFetch(`${gatewayUrl()}/gateways`);
    if (!res) return [];
    const raw = await res.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map(
      (g: Record<string, unknown>): GatewayEntry => ({
        id: str(g.id),
        name: String(g.name ?? "gateway"),
        url: str(g.url),
        transport: str(g.transport),
        description: str(g.description),
        enabled: bool(g.enabled, true),
        reachable: bool(g.reachable, true),
        createdAt: str(g.createdAt),
      }),
    );
  }

  async listTools(): Promise<GatewayToolEntry[]> {
    const res = await timedFetch(`${gatewayUrl()}/tools`);
    if (!res) return [];
    const raw = await res.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map(
      (t: Record<string, unknown>): GatewayToolEntry => ({
        id: String(t.id ?? ""),
        name: String(t.title ?? t.originalName ?? t.name ?? "tool"),
        description: str(t.description),
        integrationType: str(t.integrationType),
        enabled: bool(t.enabled, true),
      }),
    );
  }

  async listServers(): Promise<GatewayServerEntry[]> {
    const res = await timedFetch(`${gatewayUrl()}/servers`);
    if (!res) return [];
    const raw = await res.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map(
      (s: Record<string, unknown>): GatewayServerEntry => ({
        id: String(s.id ?? ""),
        name: String(s.name ?? "server"),
        description: str(s.description),
        enabled: bool(s.enabled, true),
        associatedToolCount: Array.isArray(s.associatedTools) ? s.associatedTools.length : 0,
      }),
    );
  }

  async listAgents(): Promise<GatewayAgentEntry[]> {
    const res = await timedFetch(`${gatewayUrl()}/a2a`);
    if (!res) return [];
    const raw = await res.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map(
      (a: Record<string, unknown>): GatewayAgentEntry => ({
        id: str(a.id),
        name: String(a.name ?? "agent"),
        slug: str(a.slug),
        description: str(a.description),
        endpointUrl: String(a.endpointUrl ?? ""),
        agentType: str(a.agentType),
        protocolVersion: str(a.protocolVersion),
        enabled: bool(a.enabled, true),
        reachable: bool(a.reachable, true),
      }),
    );
  }

  async listAudit(limit = 100): Promise<GatewayAuditEntry[]> {
    const res = await timedFetch(`${gatewayUrl()}/api/logs/audit-trails?limit=${limit}`);
    if (!res) return [];
    const raw = await res.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map(
      (e: Record<string, unknown>): GatewayAuditEntry => ({
        id: String(e.id ?? ""),
        timestamp: String(e.timestamp ?? ""),
        correlationId: str(e.correlation_id),
        action: String(e.action ?? ""),
        resourceType: String(e.resource_type ?? ""),
        resourceId: str(e.resource_id),
        resourceName: str(e.resource_name),
        userId: String(e.user_id ?? ""),
        userEmail: str(e.user_email),
        success: bool(e.success, true),
        requiresReview: bool(e.requires_review, false),
      }),
    );
  }

  async metrics(): Promise<GatewayMetrics> {
    const res = await timedFetch(`${gatewayUrl()}/metrics`);
    if (!res) {
      return { reachable: false, tools: null, servers: null, a2aAgents: null, error: "gateway unreachable" };
    }
    const raw = await res.json().catch(() => null);
    if (!raw) {
      return { reachable: true, tools: null, servers: null, a2aAgents: null, error: "invalid metrics response" };
    }
    // NOTE: verified live against a real gateway instance — the response is
    // camelCase (totalExecutions/failureRate/avgResponseTime), not the
    // snake_case an earlier draft assumed.
    const pick = (m: Record<string, unknown> | undefined) =>
      m
        ? {
            totalExecutions: num(m.totalExecutions) ?? 0,
            successfulExecutions: num(m.successfulExecutions) ?? 0,
            failedExecutions: num(m.failedExecutions) ?? 0,
            failureRate: num(m.failureRate),
            avgResponseTime: num(m.avgResponseTime),
          }
        : null;
    // a2aAgents has a genuinely different shape (totalAgents/activeAgents/
    // totalInteractions/successRate/...) rather than tools/servers/prompts'
    // totalExecutions/failureRate shape — map the semantically equivalent
    // fields across rather than adding a second metrics schema.
    const pickA2a = (m: Record<string, unknown> | undefined) =>
      m
        ? {
            totalExecutions: num(m.totalInteractions) ?? 0,
            successfulExecutions: num(m.successfulInteractions) ?? 0,
            failedExecutions: num(m.failedInteractions) ?? 0,
            failureRate: (() => {
              const sr = num(m.successRate);
              return sr == null ? null : 1 - sr;
            })(),
            avgResponseTime: num(m.avgResponseTime),
          }
        : null;
    return {
      reachable: true,
      tools: pick(raw.tools),
      servers: pick(raw.servers),
      a2aAgents: pickA2a(raw.a2aAgents),
      error: null,
    };
  }

  /**
   * POST /gateways — register a new upstream MCP server. On success,
   * apex-gateway federates (auto-discovers) its tools, which is why a
   * registry re-fetch right after this call is expected to show new tools
   * too, not just the new gateway entry.
   *
   * Classifies upstream failures rather than forwarding raw gateway text:
   * - 409 → name/registration conflict (gateway already knows this name/URL)
   * - 422 → validation, most commonly apex-gateway's SSRF guard rejecting a
   *   docker-internal/private-network host (see SSRF_ALLOW_PRIVATE_NETWORKS)
   * - 502 → apex-gateway reached out but couldn't connect to the URL
   * - network/timeout failure reaching apex-gateway itself → "unreachable"
   */
  async registerGateway(input: {
    name: string;
    url: string;
    transport: "SSE" | "STREAMABLEHTTP" | "STDIO";
    description?: string | null;
  }): Promise<GatewayWriteResult> {
    const res = await timedWrite(`${gatewayUrl()}/gateways`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        url: input.url,
        transport: input.transport,
        ...(input.description ? { description: input.description } : {}),
      }),
    });
    if (!res) {
      return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    }
    if (res.status >= 200 && res.status < 300) {
      const body = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(body.id), name: String(body.name ?? input.name) };
    }
    if (res.status === 409) {
      return { ok: false, status: "conflict", message: extractMessage(res.body, "Gateway name already exists") };
    }
    if (res.status === 422) {
      return { ok: false, status: "validation", message: extractMessage(res.body, "Validation failed") };
    }
    if (res.status === 502) {
      return { ok: false, status: "upstream_unreachable", message: extractMessage(res.body, "Upstream gateway unreachable") };
    }
    return { ok: false, status: "error", message: extractMessage(res.body, `Registration failed (${res.status})`) };
  }

  /**
   * DELETE /gateways/{id} — confirmed present in the fork (mcpgateway/main.py,
   * `gateways.delete` permission), unlike a guessed endpoint. Returns
   * `{ok:false}` (never throws) on 403/404/400/unreachable so callers can
   * render an inline message the same way registerGateway does.
   */
  async deleteGateway(id: string): Promise<GatewayWriteResult> {
    const res = await timedWrite(`${gatewayUrl()}/gateways/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) {
      return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, id, name: id };
    }
    // delete_gateway raises plain HTTPException(detail=...), not {message: ...}
    const body = res.body as Record<string, unknown> | null;
    const message = typeof body?.detail === "string" ? body.detail : extractMessage(res.body, `Delete failed (${res.status})`);
    return { ok: false, status: "error", message };
  }

  // ── LLM model-plane API (/llm/providers, /llm/models) ──────────────────
  // These endpoints are on the gateway's LLM routing layer (not the MCP
  // tool gateway). They manage the set of LLM providers and the model
  // aliases (apex-*) that consumers call without knowing which backend serves
  // them. The gateway's LLM plane is intentionally separate from its MCP tool
  // plane — different concern, different object graph.

  /** POST /llm/providers — register an LLM provider. */
  async createLLMProvider(input: {
    name: string;
    providerType: "openai_compatible" | "openai" | "anthropic";
    apiBase?: string;
    apiKey?: string;
    defaultModel?: string;
    description?: string;
    /** Per-provider SSRF bypass for private/docker-internal hosts. Silently ignored
     *  by gateway versions that do not support this field — use the gateway-level
     *  SSRF_ALLOW_PRIVATE_NETWORKS env var as the fallback in that case. */
    ssrfAllowPrivateNetworks?: boolean;
  }): Promise<GatewayWriteResult> {
    const body: Record<string, unknown> = {
      name: input.name,
      provider_type: input.providerType,
      enabled: true,
    };
    if (input.apiBase) body.api_base = input.apiBase;
    if (input.apiKey) body.api_key = input.apiKey;
    if (input.defaultModel) body.default_model = input.defaultModel;
    if (input.description) body.description = input.description;
    if (input.ssrfAllowPrivateNetworks) body.ssrf_allow_private_networks = true;

    const res = await timedWrite(`${gatewayUrl()}/llm/providers`, { method: "POST", body: JSON.stringify(body) });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) {
      const b = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(b.id), name: String(b.name ?? input.name) };
    }
    if (res.status === 409) return { ok: false, status: "conflict", message: extractMessage(res.body, "Provider already exists") };
    if (res.status === 422) return { ok: false, status: "validation", message: extractMessage(res.body, "Validation failed") };
    return { ok: false, status: "error", message: extractMessage(res.body, `Create provider failed (${res.status})`) };
  }

  /** GET /llm/providers — list registered LLM providers. */
  async listLLMProviders(): Promise<Array<{ id: string; name: string; providerType: string; apiBase: string | null; enabled: boolean }>> {
    const res = await timedFetch(`${gatewayUrl()}/llm/providers`);
    if (!res) return [];
    const raw = await res.json().catch(() => null);
    // Response is either a list or a {providers: [...]} envelope depending on gateway version
    const rows = Array.isArray(raw) ? raw : Array.isArray((raw as Record<string, unknown>)?.providers) ? (raw as Record<string, unknown>).providers as unknown[] : [];
    return (rows as Record<string, unknown>[]).map((p) => ({
      id: String(p.id ?? ""),
      name: String(p.name ?? ""),
      providerType: String(p.provider_type ?? ""),
      apiBase: str(p.api_base),
      enabled: bool(p.enabled, true),
    }));
  }

  /** DELETE /llm/providers/{id} — remove an LLM provider and all its models. */
  async deleteLLMProvider(id: string): Promise<GatewayWriteResult> {
    const res = await timedWrite(`${gatewayUrl()}/llm/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) return { ok: true, id, name: id };
    const body = res.body as Record<string, unknown> | null;
    const message = typeof body?.detail === "string" ? body.detail : extractMessage(res.body, `Delete provider failed (${res.status})`);
    return { ok: false, status: "error", message };
  }

  /** POST /llm/models — register a model (with optional routing alias). */
  async createLLMModel(input: {
    providerId: string;
    modelId: string;
    modelName: string;
    modelAlias?: string;
    supportsChat?: boolean;
    supportsStreaming?: boolean;
  }): Promise<GatewayWriteResult> {
    const body: Record<string, unknown> = {
      provider_id: input.providerId,
      model_id: input.modelId,
      model_name: input.modelName,
      enabled: true,
      supports_chat: input.supportsChat ?? true,
      supports_streaming: input.supportsStreaming ?? true,
    };
    if (input.modelAlias) body.model_alias = input.modelAlias;

    const res = await timedWrite(`${gatewayUrl()}/llm/models`, { method: "POST", body: JSON.stringify(body) });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) {
      const b = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(b.id), name: String(b.model_alias ?? b.model_name ?? input.modelAlias ?? input.modelName) };
    }
    if (res.status === 409) return { ok: false, status: "conflict", message: extractMessage(res.body, "Model already exists") };
    if (res.status === 422) return { ok: false, status: "validation", message: extractMessage(res.body, "Validation failed") };
    return { ok: false, status: "error", message: extractMessage(res.body, `Create model failed (${res.status})`) };
  }

  /** GET /llm/models — list registered LLM models (including aliases). */
  async listLLMModels(): Promise<Array<{ id: string; modelId: string; modelName: string; modelAlias: string | null; providerId: string; enabled: boolean }>> {
    const res = await timedFetch(`${gatewayUrl()}/llm/models`);
    if (!res) return [];
    const raw = await res.json().catch(() => null);
    const rows = Array.isArray(raw) ? raw : Array.isArray((raw as Record<string, unknown>)?.models) ? (raw as Record<string, unknown>).models as unknown[] : [];
    return (rows as Record<string, unknown>[]).map((m) => ({
      id: String(m.id ?? ""),
      modelId: String(m.model_id ?? ""),
      modelName: String(m.model_name ?? ""),
      modelAlias: str(m.model_alias),
      providerId: String(m.provider_id ?? ""),
      enabled: bool(m.enabled, true),
    }));
  }

  /** DELETE /llm/models/{id} — remove a model/alias. */
  async deleteLLMModel(id: string): Promise<GatewayWriteResult> {
    const res = await timedWrite(`${gatewayUrl()}/llm/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) return { ok: true, id, name: id };
    const body = res.body as Record<string, unknown> | null;
    const message = typeof body?.detail === "string" ? body.detail : extractMessage(res.body, `Delete model failed (${res.status})`);
    return { ok: false, status: "error", message };
  }

  // ── Prompts registry (/prompts) ──────────────────────────────────────────
  // The gateway's ContextForge fork ships prompt_service.py and a prompts
  // table but the cockpit never called these endpoints. Wiring them here
  // lets the Prompt Library page show what the gateway already knows about,
  // so operators can adopt rather than rebuild.

  /** GET /prompts — list all MCP prompts the gateway knows about. */
  async listGatewayPrompts(): Promise<GatewayPromptEntry[]> {
    const res = await timedFetch(`${gatewayUrl()}/prompts`);
    if (!res) return [];
    const raw = await res.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : [];
    return rows.map(
      (p: Record<string, unknown>): GatewayPromptEntry => ({
        id: str(p.id),
        name: String(p.name ?? "prompt"),
        description: str(p.description),
        arguments: Array.isArray(p.arguments)
          ? (p.arguments as Record<string, unknown>[]).map((a) => ({
              name: String(a.name ?? ""),
              description: str(a.description),
              required: bool(a.required, false),
            }))
          : [],
        enabled: bool(p.enabled, true),
        createdAt: str(p.createdAt ?? p.created_at),
      }),
    );
  }

  /** POST /prompts — register a new MCP prompt in the gateway registry. */
  async createGatewayPrompt(input: {
    name: string;
    description?: string | null;
    arguments?: Array<{ name: string; description?: string | null; required?: boolean }>;
    template?: string;
  }): Promise<GatewayWriteResult> {
    const body: Record<string, unknown> = {
      name: input.name,
      enabled: true,
    };
    if (input.description) body.description = input.description;
    if (input.arguments?.length) body.arguments = input.arguments;
    if (input.template) body.template = input.template;

    const res = await timedWrite(`${gatewayUrl()}/prompts`, { method: "POST", body: JSON.stringify(body) });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) {
      const b = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(b.id), name: String(b.name ?? input.name) };
    }
    if (res.status === 409) return { ok: false, status: "conflict", message: extractMessage(res.body, "Prompt name already exists") };
    if (res.status === 422) return { ok: false, status: "validation", message: extractMessage(res.body, "Validation failed") };
    return { ok: false, status: "error", message: extractMessage(res.body, `Create prompt failed (${res.status})`) };
  }

  /** DELETE /prompts/{id} — remove a prompt from the gateway registry. */
  async deleteGatewayPrompt(id: string): Promise<GatewayWriteResult> {
    const res = await timedWrite(`${gatewayUrl()}/prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) return { ok: true, id, name: id };
    const body = res.body as Record<string, unknown> | null;
    const message = typeof body?.detail === "string" ? body.detail : extractMessage(res.body, `Delete prompt failed (${res.status})`);
    return { ok: false, status: "error", message };
  }
}
