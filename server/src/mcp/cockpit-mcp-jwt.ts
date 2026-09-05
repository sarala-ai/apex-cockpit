/**
 * cockpit-mcp-jwt.ts
 *
 * Mint and verify JWTs for the cockpit MCP server (audience "cockpit-mcp").
 * Extends the existing per-instance/per-company HMAC-SHA256 signing scheme
 * from agent-auth-jwt.ts but adds MCP-specific claims: granted_capabilities,
 * issue_id, case_id, project_id.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { RUN_TOKEN_FORBIDDEN_CAPABILITIES } from "./capabilities.js";

const JWT_ALGORITHM = "HS256";
export const COCKPIT_MCP_AUDIENCE = "cockpit-mcp";

export interface CockpitMcpJwtClaims {
  sub: string; // agentId (run tokens), userId (user tokens), "apex-gateway" (federation)
  // "run"/"user" are the HS256 tokens minted here. "user" is also what a
  // cockpit-issued operator principal JWT becomes once the router has verified
  // it (mcp/router.ts). "gateway_federation" is the gateway's own probe
  // credential: no company, no capabilities, probe surface only.
  token_kind: "run" | "user" | "gateway_federation";
  company_id: string; // "" for gateway_federation, which is company-less
  run_id: string | null; // null for user-scoped (OAuth) tokens
  user_id: string | null; // null for run-scoped tokens
  adapter_type: string | null; // null for user-scoped tokens
  granted_capabilities: string[];
  issue_id?: string | null;
  case_id?: string | null;
  project_id?: string | null;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  instance_id: string;
}

function jwtConfig() {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return null;
  return {
    secret,
    ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60),
    issuer: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    instanceId: resolvePaperclipInstanceId(),
  };
}

function parseNumber(v: string | undefined, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function deriveSigningKey(masterSecret: string, companyId: string, instanceId: string): string {
  return createHmac("sha256", masterSecret)
    .update(`jwt:${instanceId}:${companyId}`)
    .digest("hex");
}

function base64UrlEncode(s: string) {
  return Buffer.from(s, "utf8").toString("base64url");
}
function base64UrlDecode(s: string) {
  return Buffer.from(s, "base64url").toString("utf8");
}
function signPayload(secret: string, input: string) {
  return createHmac("sha256", secret).update(input).digest("base64url");
}
function safeCompare(a: string, b: string): boolean {
  const la = Buffer.from(a);
  const lb = Buffer.from(b);
  if (la.length !== lb.length) return false;
  return timingSafeEqual(la, lb);
}
function parseJson(s: string): Record<string, unknown> | null {
  try {
    const p = JSON.parse(s);
    return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function mintCockpitMcpJwt(input: {
  agentId: string;
  companyId: string;
  runId: string;
  adapterType: string;
  grantedCapabilities: string[];
  issueId?: string | null;
  caseId?: string | null;
  projectId?: string | null;
}): string | null {
  const cfg = jwtConfig();
  if (!cfg) return null;

  const now = Math.floor(Date.now() / 1000);
  // Privileged capabilities are stripped HERE rather than at each dispatch
  // site: the grant reaching this function has already flowed through a
  // lifecycle node's YAML, an issue-level adapter override and a default, and
  // any one of those could grow a way to name secrets:write. One mint, one
  // filter — a run token cannot carry it however it was asked for.
  const grantedCapabilities = input.grantedCapabilities.filter(
    (cap) => !RUN_TOKEN_FORBIDDEN_CAPABILITIES.includes(cap),
  );
  const claims: CockpitMcpJwtClaims = {
    sub: input.agentId,
    token_kind: "run",
    company_id: input.companyId,
    run_id: input.runId,
    user_id: null,
    adapter_type: input.adapterType,
    granted_capabilities: grantedCapabilities,
    issue_id: input.issueId ?? null,
    case_id: input.caseId ?? null,
    project_id: input.projectId ?? null,
    iat: now,
    exp: now + cfg.ttlSeconds,
    iss: cfg.issuer,
    aud: COCKPIT_MCP_AUDIENCE,
    instance_id: cfg.instanceId,
  };

  return signClaims(cfg.secret, cfg.instanceId, claims);
}

/**
 * Mint a user-scoped access token for the OAuth 2.1 external-host flow (T7).
 * No run identity: run_id/adapter_type are null, audit rows carry user_id.
 */
export function mintCockpitMcpUserJwt(input: {
  userId: string;
  companyId: string;
  grantedCapabilities: string[];
}): string | null {
  const cfg = jwtConfig();
  if (!cfg) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: CockpitMcpJwtClaims = {
    sub: input.userId,
    token_kind: "user",
    company_id: input.companyId,
    run_id: null,
    user_id: input.userId,
    adapter_type: null,
    granted_capabilities: input.grantedCapabilities,
    issue_id: null,
    case_id: null,
    project_id: null,
    iat: now,
    exp: now + cfg.ttlSeconds,
    iss: cfg.issuer,
    aud: COCKPIT_MCP_AUDIENCE,
    instance_id: cfg.instanceId,
  };

  return signClaims(cfg.secret, cfg.instanceId, claims);
}

function signClaims(masterSecret: string, instanceId: string, claims: CockpitMcpJwtClaims): string {
  const header = { alg: JWT_ALGORITHM, typ: "JWT" };
  const signingInput =
    `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = deriveSigningKey(masterSecret, claims.company_id, instanceId);
  return `${signingInput}.${signPayload(key, signingInput)}`;
}

export type CockpitMcpVerifyResult =
  | { ok: true; claims: CockpitMcpJwtClaims }
  | { ok: false; reason: "missing" | "malformed" | "wrong_audience" | "expired" | "bad_signature" };

export function verifyCockpitMcpJwt(token: string | null | undefined): CockpitMcpVerifyResult {
  if (!token) return { ok: false, reason: "missing" };
  const cfg = jwtConfig();
  if (!cfg) return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, claimsB64, sig] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return { ok: false, reason: "malformed" };

  const raw = parseJson(base64UrlDecode(claimsB64));
  if (!raw) return { ok: false, reason: "malformed" };

  const companyId = typeof raw.company_id === "string" ? raw.company_id : null;
  if (!companyId) return { ok: false, reason: "malformed" };

  const aud = typeof raw.aud === "string" ? raw.aud : null;
  if (aud !== COCKPIT_MCP_AUDIENCE) return { ok: false, reason: "wrong_audience" };

  const signingInput = `${headerB64}.${claimsB64}`;
  const key = deriveSigningKey(cfg.secret, companyId, cfg.instanceId);
  const expected = signPayload(key, signingInput);
  if (!safeCompare(sig, expected)) return { ok: false, reason: "bad_signature" };

  const exp = typeof raw.exp === "number" ? raw.exp : null;
  if (!exp || exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };

  const sub = typeof raw.sub === "string" ? raw.sub : null;
  const runId = typeof raw.run_id === "string" ? raw.run_id : null;
  const userId = typeof raw.user_id === "string" ? raw.user_id : null;
  const adapterType = typeof raw.adapter_type === "string" ? raw.adapter_type : null;
  // token_kind was introduced with T7; run tokens minted before it lack the claim.
  const tokenKind = raw.token_kind === "user" ? "user" : "run";
  if (!sub) return { ok: false, reason: "malformed" };
  if (tokenKind === "run" && (!runId || !adapterType)) return { ok: false, reason: "malformed" };
  if (tokenKind === "user" && !userId) return { ok: false, reason: "malformed" };

  const caps = Array.isArray(raw.granted_capabilities)
    ? (raw.granted_capabilities as unknown[]).filter((c): c is string => typeof c === "string")
    : [];

  return {
    ok: true,
    claims: {
      sub,
      token_kind: tokenKind,
      company_id: companyId,
      run_id: tokenKind === "run" ? runId : null,
      user_id: tokenKind === "user" ? userId : null,
      adapter_type: tokenKind === "run" ? adapterType : null,
      granted_capabilities: caps,
      issue_id: typeof raw.issue_id === "string" ? raw.issue_id : null,
      case_id: typeof raw.case_id === "string" ? raw.case_id : null,
      project_id: typeof raw.project_id === "string" ? raw.project_id : null,
      iat: typeof raw.iat === "number" ? raw.iat : 0,
      exp,
      iss: typeof raw.iss === "string" ? raw.iss : cfg.issuer,
      aud: COCKPIT_MCP_AUDIENCE,
      instance_id: typeof raw.instance_id === "string" ? raw.instance_id : cfg.instanceId,
    },
  };
}
