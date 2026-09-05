/**
 * GatewayClient — thin client for apex-gateway (ContextForge fork): timed,
 * abortable fetch with a bearer credential. Every method narrows the gateway's response to an explicit
 * safe field pick (see @paperclipai/shared/gateway) — never forwards raw
 * payloads, so auth_value/auth_headers/oauth_config and similar secret-bearing
 * fields can't leak to the browser even if the gateway's schema grows a new one.
 *
 * Failure-isolated: every list method returns an empty result on any failure
 * rather than throwing, so a down gateway degrades the Gateway page/Observe
 * metrics to empty state, never a 500. Failures are still classified
 * (GatewayFailure): a 401/403 is a credential problem and must never be
 * reported as "unreachable" — callers that surface state to operators use the
 * `read*` variants or `probe()` to get the classification.
 *
 * Credential: a per-request operator principal JWT, the cockpit's own system
 * principal (a token source, re-minted on expiry), or — for local/unauth
 * gateways — the APEX_GATEWAY_TOKEN env fallback. Never a static shared
 * service token on a hosted deployment.
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

/** The gateway base URL this process is configured to talk to. */
export const gatewayUrl = (): string =>
  (process.env.APEX_GATEWAY_URL ?? "http://127.0.0.1:4444").replace(/\/$/, "");

/**
 * Classified failure of a gateway call. `unauthenticated`/`forbidden` mean
 * the gateway answered and rejected the credential (401/403); `unreachable`
 * is a transport failure (network/timeout); `http` is any other non-2xx;
 * `credential_unavailable` means the cockpit never sent a request at all —
 * its own token source (e.g. the system-principal JWT signer) failed to
 * produce a credential, so this is never the gateway's fault.
 */
export interface GatewayFailure {
  kind: "unauthenticated" | "forbidden" | "http" | "unreachable" | "credential_unavailable";
  status: number | null;
  message: string;
}

export type GatewayHttp<T> = { ok: true; value: T } | { ok: false; failure: GatewayFailure };

export function classifyStatus(status: number, detail?: string | null): GatewayFailure {
  const suffix = detail ? `: ${detail}` : "";
  if (status === 401) return { kind: "unauthenticated", status, message: `apex-gateway rejected the credential (401)${suffix}` };
  if (status === 403) return { kind: "forbidden", status, message: `apex-gateway refused the credential (403)${suffix}` };
  return { kind: "http", status, message: `apex-gateway returned ${status}${suffix}` };
}

const UNREACHABLE: GatewayFailure = { kind: "unreachable", status: null, message: "apex-gateway is unreachable" };

/**
 * A credential for gateway calls: a bearer string, a source that mints one
 * on demand (the cockpit system principal), or nothing — which falls back
 * to APEX_GATEWAY_TOKEN for local/unauthenticated gateways.
 */
export type GatewayCredential = string | null | undefined | (() => Promise<string | null>);

/** Resolving a credential either yields a token (possibly null, meaning
 *  "fall back to APEX_GATEWAY_TOKEN") or a classified failure when a token
 *  source function threw instead of returning — a mint failure, never a
 *  legitimate "no credential configured" case. */
interface ResolvedCredential {
  token: string | null;
  failure: GatewayFailure | null;
}

const CREDENTIAL_UNAVAILABLE_MESSAGE_PREFIX = "cockpit could not mint its gateway principal";

async function resolveToken(credential: GatewayCredential): Promise<ResolvedCredential> {
  if (typeof credential !== "function") {
    return { token: credential ?? process.env.APEX_GATEWAY_TOKEN ?? null, failure: null };
  }
  try {
    const token = await credential();
    return { token: token ?? process.env.APEX_GATEWAY_TOKEN ?? null, failure: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      token: null,
      failure: { kind: "credential_unavailable", status: null, message: `${CREDENTIAL_UNAVAILABLE_MESSAGE_PREFIX}: ${reason}` },
    };
  }
}

function bearerHeaders(token: string | null): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function timedFetch(url: string, token: string | null, timeoutMs = 5000): Promise<GatewayHttp<Response>> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) return { ok: true, value: res };
    const detail = await res
      .json()
      .then((b: unknown) => extractMessage(b, ""))
      .catch(() => "");
    return { ok: false, failure: classifyStatus(res.status, detail || null) };
  } catch {
    return { ok: false, failure: UNREACHABLE };
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
/**
 * The credential the gateway stores (encrypted, mcpgateway GatewayCreate /
 * GatewayUpdate `auth_type` + `auth_token`) and presents to an upstream.
 * `oauthConfig` rides along for the gateway's per-upstream auth policy —
 * for cockpit-mcp, `login_passthrough` (forward the caller's own principal
 * JWT over the stored bearer on tool calls) and the issuer it is pinned to.
 */
export interface GatewayUpstreamAuth {
  authType?: "bearer";
  authToken?: string;
  oauthConfig?: Record<string, unknown>;
}

function upstreamAuthBody(input: GatewayUpstreamAuth): Record<string, unknown> {
  return {
    ...(input.authType && input.authToken ? { auth_type: input.authType, auth_token: input.authToken } : {}),
    ...(input.oauthConfig ? { oauth_config: input.oauthConfig } : {}),
  };
}

export type GatewayWriteResult =
  | { ok: true; id: string | null; name: string }
  | {
      ok: false;
      // "unreachable" = we couldn't even reach apex-gateway itself (network/timeout).
      // "upstream_unreachable" = apex-gateway is up but couldn't connect to the
      // registered URL (its 502) — a different, more actionable failure.
      // "auth" = apex-gateway answered 401/403: the cockpit's credential is
      // missing or not trusted — never a reachability problem.
      // "credential_unavailable" = the cockpit never sent the request: its
      // own token source failed to mint a credential.
      status: "conflict" | "validation" | "unreachable" | "upstream_unreachable" | "auth" | "credential_unavailable" | "error";
      message: string;
    };

function authWriteFailure(res: { status: number; body: unknown }): GatewayWriteResult | null {
  if (res.status !== 401 && res.status !== 403) return null;
  const detail = extractMessage(res.body, "");
  return { ok: false, status: "auth", message: classifyStatus(res.status, detail || null).message };
}

/** Sentinel status `write()` uses on its `{status, body}` shape to signal a
 *  credential-mint failure rather than any real HTTP response. */
const CREDENTIAL_UNAVAILABLE_STATUS = -1;

function credentialFailureWriteResult(res: { status: number; body: unknown }): GatewayWriteResult | null {
  if (res.status !== CREDENTIAL_UNAVAILABLE_STATUS) return null;
  return { ok: false, status: "credential_unavailable", message: extractMessage(res.body, CREDENTIAL_UNAVAILABLE_MESSAGE_PREFIX) };
}

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
  token: string | null,
  timeoutMs = 8000,
): Promise<{ status: number; body: unknown } | null> {
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
  /**
   * @param credential See GatewayCredential: a per-request operator JWT for
   * operator-initiated calls, the cockpit system token source for
   * process-level probes, or nothing for local/unauthenticated gateways.
   */
  constructor(private readonly credentialSource?: GatewayCredential) {}

  private async credential(): Promise<ResolvedCredential> {
    return resolveToken(this.credentialSource);
  }

  private async token(): Promise<string | null> {
    return (await this.credential()).token;
  }

  private async get(url: string): Promise<Response | null> {
    const cred = await this.credential();
    if (cred.failure) return null;
    const res = await timedFetch(url, cred.token);
    return res.ok ? res.value : null;
  }

  private async getClassified(url: string, timeoutMs?: number): Promise<GatewayHttp<Response>> {
    const cred = await this.credential();
    if (cred.failure) return { ok: false, failure: cred.failure };
    return timedFetch(url, cred.token, timeoutMs);
  }

  private async write(url: string, init: RequestInit, timeoutMs?: number): Promise<{ status: number; body: unknown } | null> {
    const cred = await this.credential();
    if (cred.failure) return { status: CREDENTIAL_UNAVAILABLE_STATUS, body: { message: cred.failure.message } };
    return timedWrite(url, init, cred.token, timeoutMs);
  }

  /** Transport-level liveness: any HTTP answer from /health counts. The
   *  gateway's own /health does a Cloud SQL round-trip and can cold-start
   *  past the default timeout, so this probe gets a longer allowance. */
  async reachable(): Promise<boolean> {
    const res = await this.getClassified(`${gatewayUrl()}/health`, 15000);
    return res.ok || res.failure.kind !== "unreachable";
  }

  /**
   * Liveness AND credential acceptance, via the authenticated registry read.
   * `authenticated: null` means the gateway could not be reached at all.
   */
  async probe(): Promise<{ reachable: boolean; authenticated: boolean | null; failure: GatewayFailure | null }> {
    const res = await this.getClassified(`${gatewayUrl()}/gateways`);
    if (res.ok) return { reachable: true, authenticated: true, failure: null };
    const f = res.failure;
    if (f.kind === "unreachable" || f.kind === "credential_unavailable") return { reachable: false, authenticated: null, failure: f };
    return { reachable: true, authenticated: f.kind !== "unauthenticated" && f.kind !== "forbidden", failure: f };
  }

  /** GET /gateways with the failure classification preserved. */
  async readGateways(): Promise<GatewayHttp<GatewayEntry[]>> {
    const res = await this.getClassified(`${gatewayUrl()}/gateways`);
    if (!res.ok) return res;
    const raw = await res.value.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : [];
    return {
      ok: true,
      value: rows.map(
        (g: Record<string, unknown>): GatewayEntry => ({
          id: str(g.id),
          name: String(g.name ?? "gateway"),
          url: str(g.url),
          transport: str(g.transport),
          description: str(g.description),
          enabled: bool(g.enabled, true),
          reachable: bool(g.reachable, true),
          authType: str(g.authType),
          createdAt: str(g.createdAt),
        }),
      ),
    };
  }

  /**
   * The registry's OAuth posture, as booleans only: which upstreams are
   * registered with authType "oauth" and whether each carries an OAuth
   * config. The config itself (client id/secret, URLs) is never read past
   * this method.
   */
  async readGatewayOauthPosture(): Promise<GatewayHttp<Array<{ name: string; authType: string | null; oauthConfigured: boolean }>>> {
    const res = await this.getClassified(`${gatewayUrl()}/gateways`);
    if (!res.ok) return res;
    const raw = await res.value.json().catch(() => []);
    const rows = Array.isArray(raw) ? raw : [];
    return {
      ok: true,
      value: rows.map((g: Record<string, unknown>) => ({
        name: String(g.name ?? "gateway"),
        authType: str(g.authType),
        oauthConfigured: g.oauthConfig != null && typeof g.oauthConfig === "object" && Object.keys(g.oauthConfig as object).length > 0,
      })),
    };
  }

  // NOTE: gateways/tools/a2a/servers all extend ContextForge's
  // BaseModelWithConfigDict, which auto-converts snake_case Python field
  // names to camelCase on JSON serialization (verified against a live
  // instance) — read camelCase here, NOT the Python attribute names.
  // AuditTrailResponse below is a plain BaseModel (no such conversion),
  // confirmed to stay snake_case.
  async listGateways(): Promise<GatewayEntry[]> {
    const res = await this.readGateways();
    return res.ok ? res.value : [];
  }

  /**
   * Resolve the provider authorization URL for an OAuth (authorization_code)
   * gateway, WITHOUT following it — the gateway answers with a redirect to the
   * provider's consent page, bound server-side to the identity in the bearer
   * token. Callers must pass an operator-minted client (never the env token):
   * the consent token the provider hands back is stored keyed to this
   * identity's email, and MCP calls later look tokens up by the CALLING
   * user's email — an env-token identity here would strand the consent.
   */
  async oauthAuthorizeLocation(gatewayId: string): Promise<{ ok: true; url: string } | { ok: false; status: number; message: string }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${gatewayUrl()}/oauth/authorize/${encodeURIComponent(gatewayId)}`, {
        redirect: "manual",
        signal: controller.signal,
        headers: bearerHeaders(await this.token()),
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location) return { ok: true, url: location };
        return { ok: false, status: 502, message: "gateway redirected without a Location header" };
      }
      const detail = await res
        .json()
        .then((b: Record<string, unknown>) => String(b.detail ?? b.message ?? res.statusText))
        .catch(() => res.statusText);
      return { ok: false, status: res.status, message: detail };
    } catch {
      return { ok: false, status: 502, message: "apex-gateway is unreachable" };
    } finally {
      clearTimeout(t);
    }
  }

  /** Trigger a tool sync for an OAuth gateway after consent completes. */
  async oauthFetchTools(gatewayId: string): Promise<{ ok: boolean; status: number; message: string }> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${gatewayUrl()}/oauth/fetch-tools/${encodeURIComponent(gatewayId)}`, {
        method: "POST",
        signal: controller.signal,
        headers: bearerHeaders(await this.token()),
      });
      const message = await res
        .json()
        .then((b: Record<string, unknown>) => String(b.detail ?? b.message ?? res.statusText))
        .catch(() => res.statusText);
      return { ok: res.ok, status: res.status, message };
    } catch {
      return { ok: false, status: 502, message: "apex-gateway is unreachable" };
    } finally {
      clearTimeout(t);
    }
  }

  async listTools(): Promise<GatewayToolEntry[]> {
    const res = await this.get(`${gatewayUrl()}/tools`);
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
    const res = await this.get(`${gatewayUrl()}/servers`);
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
    const res = await this.get(`${gatewayUrl()}/a2a`);
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
    const res = await this.get(`${gatewayUrl()}/api/logs/audit-trails?limit=${limit}`);
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
    const http = await this.getClassified(`${gatewayUrl()}/metrics`);
    if (!http.ok) {
      const f = http.failure;
      return { reachable: f.kind !== "unreachable" && f.kind !== "credential_unavailable", tools: null, servers: null, a2aAgents: null, error: f.message };
    }
    const raw = await http.value.json().catch(() => null);
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
    /** Override the default 8s write timeout. POST /gateways makes the gateway
     *  itself connect to (and MCP-initialize) the upstream url before it
     *  answers — see registerCockpitMcpWithGateway (mcp/router.ts) for why the
     *  cockpit's own self-registration passes a much longer value here. */
    timeoutMs?: number;
  } & GatewayUpstreamAuth): Promise<GatewayWriteResult> {
    const res = await this.write(
      `${gatewayUrl()}/gateways`,
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          url: input.url,
          transport: input.transport,
          ...(input.description ? { description: input.description } : {}),
          ...upstreamAuthBody(input),
        }),
      },
      input.timeoutMs,
    );
    if (!res) {
      return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    }
    if (res.status >= 200 && res.status < 300) {
      const body = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(body.id), name: String(body.name ?? input.name) };
    }
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
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
   * PUT /gateways/{id} — update an existing federation gateway (e.g. repoint
   * its url after a stale registration). All fields optional (GatewayUpdate);
   * only the ones passed here are changed.
   */
  async updateGateway(
    id: string,
    input: {
      url?: string;
      transport?: "SSE" | "STREAMABLEHTTP" | "STDIO";
      description?: string | null;
      /** See registerGateway's timeoutMs — PUT also re-runs the upstream
       *  MCP-initialize probe when the url or the credential changes. */
      timeoutMs?: number;
    } & GatewayUpstreamAuth,
  ): Promise<GatewayWriteResult> {
    const res = await this.write(
      `${gatewayUrl()}/gateways/${encodeURIComponent(id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          ...(input.url ? { url: input.url } : {}),
          ...(input.transport ? { transport: input.transport } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...upstreamAuthBody(input),
        }),
      },
      input.timeoutMs,
    );
    if (!res) {
      return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    }
    if (res.status >= 200 && res.status < 300) {
      const body = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(body.id) ?? id, name: String(body.name ?? id) };
    }
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
    if (res.status === 409) {
      return { ok: false, status: "conflict", message: extractMessage(res.body, "Gateway name already exists") };
    }
    if (res.status === 422) {
      return { ok: false, status: "validation", message: extractMessage(res.body, "Validation failed") };
    }
    if (res.status === 502) {
      return { ok: false, status: "upstream_unreachable", message: extractMessage(res.body, "Upstream gateway unreachable") };
    }
    const body = res.body as Record<string, unknown> | null;
    const message = typeof body?.message === "string" ? body.message : extractMessage(res.body, `Update failed (${res.status})`);
    return { ok: false, status: "error", message };
  }

  /**
   * DELETE /gateways/{id} — confirmed present in the fork (mcpgateway/main.py,
   * `gateways.delete` permission), unlike a guessed endpoint. Returns
   * `{ok:false}` (never throws) on 403/404/400/unreachable so callers can
   * render an inline message the same way registerGateway does.
   */
  async deleteGateway(id: string): Promise<GatewayWriteResult> {
    const res = await this.write(`${gatewayUrl()}/gateways/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) {
      return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    }
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, id, name: id };
    }
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
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

    const res = await this.write(`${gatewayUrl()}/llm/providers`, { method: "POST", body: JSON.stringify(body) });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) {
      const b = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(b.id), name: String(b.name ?? input.name) };
    }
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
    if (res.status === 409) return { ok: false, status: "conflict", message: extractMessage(res.body, "Provider already exists") };
    if (res.status === 422) return { ok: false, status: "validation", message: extractMessage(res.body, "Validation failed") };
    return { ok: false, status: "error", message: extractMessage(res.body, `Create provider failed (${res.status})`) };
  }

  /** GET /llm/providers — list registered LLM providers. */
  async listLLMProviders(): Promise<Array<{ id: string; name: string; providerType: string; apiBase: string | null; enabled: boolean }>> {
    const res = await this.get(`${gatewayUrl()}/llm/providers`);
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
    const res = await this.write(`${gatewayUrl()}/llm/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) return { ok: true, id, name: id };
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
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

    const res = await this.write(`${gatewayUrl()}/llm/models`, { method: "POST", body: JSON.stringify(body) });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) {
      const b = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(b.id), name: String(b.model_alias ?? b.model_name ?? input.modelAlias ?? input.modelName) };
    }
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
    if (res.status === 409) return { ok: false, status: "conflict", message: extractMessage(res.body, "Model already exists") };
    if (res.status === 422) return { ok: false, status: "validation", message: extractMessage(res.body, "Validation failed") };
    return { ok: false, status: "error", message: extractMessage(res.body, `Create model failed (${res.status})`) };
  }

  /** GET /llm/models — list registered LLM models (including aliases). */
  async listLLMModels(): Promise<Array<{ id: string; modelId: string; modelName: string; modelAlias: string | null; providerId: string; enabled: boolean }>> {
    const res = await this.get(`${gatewayUrl()}/llm/models`);
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
    const res = await this.write(`${gatewayUrl()}/llm/models/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) return { ok: true, id, name: id };
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
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
    const res = await this.get(`${gatewayUrl()}/prompts`);
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

    const res = await this.write(`${gatewayUrl()}/prompts`, { method: "POST", body: JSON.stringify(body) });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) {
      const b = (res.body ?? {}) as Record<string, unknown>;
      return { ok: true, id: str(b.id), name: String(b.name ?? input.name) };
    }
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
    if (res.status === 409) return { ok: false, status: "conflict", message: extractMessage(res.body, "Prompt name already exists") };
    if (res.status === 422) return { ok: false, status: "validation", message: extractMessage(res.body, "Validation failed") };
    return { ok: false, status: "error", message: extractMessage(res.body, `Create prompt failed (${res.status})`) };
  }

  /** DELETE /prompts/{id} — remove a prompt from the gateway registry. */
  async deleteGatewayPrompt(id: string): Promise<GatewayWriteResult> {
    const res = await this.write(`${gatewayUrl()}/prompts/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res) return { ok: false, status: "unreachable", message: "apex-gateway is unreachable" };
    if (res.status >= 200 && res.status < 300) return { ok: true, id, name: id };
    const cred = credentialFailureWriteResult(res);
    if (cred) return cred;
    const auth = authWriteFailure(res);
    if (auth) return auth;
    const body = res.body as Record<string, unknown> | null;
    const message = typeof body?.detail === "string" ? body.detail : extractMessage(res.body, `Delete prompt failed (${res.status})`);
    return { ok: false, status: "error", message };
  }
}
