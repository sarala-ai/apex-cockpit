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
}
