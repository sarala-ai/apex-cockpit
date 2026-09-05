import type { PrincipalClaims } from "./auth-client.js";
import type { PrincipalJwtSigner } from "./mint-principal-jwt.js";

/**
 * The cockpit process's own principal — the identity behind gateway calls
 * that no operator initiates (boot-time self-registration, setup-state and
 * model-access probes). It is minted through the same EdDSA/JWKS path as an
 * operator token, so the gateway verifies it as a cockpit-issued principal
 * and provisions it like any other; it is never a static shared secret.
 *
 * Claim shape constraints (gateway trusted-issuer path):
 * - `email` + `email_verified: true` are required for provisioning; a token
 *   without an email claim is classified as a clientless service token and
 *   pinned non-admin.
 * - `instanceAdmin: true` mirrors onto the provisioned user, which is what
 *   the registry/LLM-plane/metrics endpoints require.
 */
export const COCKPIT_SYSTEM_SUBJECT = "cockpit-system";

export interface CockpitSystemClaims extends PrincipalClaims {
  sub: typeof COCKPIT_SYSTEM_SUBJECT;
  principalKind: "cockpit_system";
}

function issuerHost(issuerUrl: string | null | undefined): string {
  if (!issuerUrl) return "localhost";
  try {
    return new URL(issuerUrl).hostname || "localhost";
  } catch {
    return "localhost";
  }
}

export function buildCockpitSystemClaims(issuerUrl: string | null | undefined): CockpitSystemClaims {
  return {
    sub: COCKPIT_SYSTEM_SUBJECT,
    principalKind: "cockpit_system",
    email: `${COCKPIT_SYSTEM_SUBJECT}@${issuerHost(issuerUrl)}`,
    email_verified: true,
    name: null,
    idp: null,
    instanceAdmin: true,
    companyId: null,
    companies: [],
    teams: [],
  };
}

/** Issuer, audience ("apex-gateway") and expiry come from the jwt plugin's
 *  configured options, exactly as for an operator token. */
export async function mintCockpitSystemJwt(
  auth: PrincipalJwtSigner,
  issuerUrl: string | null | undefined,
): Promise<string> {
  const result = await auth.api.signJWT({ body: { payload: { ...buildCockpitSystemClaims(issuerUrl) } } });
  const token = typeof result === "string" ? result : result?.token;
  if (!token || typeof token !== "string") {
    throw new Error("cockpit system JWT mint returned no token");
  }
  return token;
}

/**
 * The gateway-federation principal — the credential the APEX gateway holds
 * to dial cockpit's own /mcp (registration probe, health check, catalog
 * sync). It is the mirror image of the system principal: cockpit-system is
 * what cockpit presents TO the gateway; apex-gateway is what the gateway
 * presents BACK to cockpit-mcp. Same EdDSA/JWKS path, so cockpit-mcp verifies
 * it with its own keys — no static shared secret anywhere.
 *
 * Authorized for the probe surface only (initialize + list methods;
 * mcp/router.ts FEDERATION_PROBE_METHODS) and never for a tool call — an
 * operator's forwarded principal token carries tool calls. Hence no
 * companies, no admin, and no email: it is not a user of anything.
 *
 * Lifetime: the gateway stores this token (encrypted) as the upstream
 * credential and cannot refresh it itself, so cockpit's registration sweep
 * re-points the registration with a fresh token before expiry. The sweep
 * tolerates a missed tick only if the token outlives two intervals; keep
 * `lifetimeSeconds` and the sweep's refresh rule in step
 * (registration-sweep.ts federationCredentialPolicy).
 */
export const GATEWAY_FEDERATION_SUBJECT = "apex-gateway";

export interface GatewayFederationClaims extends PrincipalClaims {
  sub: typeof GATEWAY_FEDERATION_SUBJECT;
  principalKind: "gateway_federation";
}

export function buildGatewayFederationClaims(): GatewayFederationClaims {
  return {
    sub: GATEWAY_FEDERATION_SUBJECT,
    principalKind: "gateway_federation",
    email: null,
    email_verified: false,
    name: null,
    idp: null,
    instanceAdmin: false,
    companyId: null,
    companies: [],
    teams: [],
  };
}

export async function mintGatewayFederationJwt(
  auth: PrincipalJwtSigner,
  opts: { lifetimeSeconds: number; now?: () => number },
): Promise<string> {
  const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
  // The plugin honours an explicit `exp` over its configured 15m default;
  // issuer/audience still come from its options like every principal token.
  const payload = { ...buildGatewayFederationClaims(), iat: nowSec, exp: nowSec + Math.max(60, Math.floor(opts.lifetimeSeconds)) };
  const result = await auth.api.signJWT({ body: { payload } });
  const token = typeof result === "string" ? result : result?.token;
  if (!token || typeof token !== "string") {
    throw new Error("gateway federation JWT mint returned no token");
  }
  return token;
}

export type TokenSource = () => Promise<string | null>;

/** `exp` (seconds) from an unverified JWT payload; null when absent/unparseable. */
export function jwtExpiryMs(token: string): number | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Caches a minted token until shortly before its expiry, then re-mints.
 * Concurrent callers share one in-flight mint. A mint failure rejects — the
 * caller (GatewayClient) classifies that as `credential_unavailable` rather
 * than sending an unauthenticated request — and is retried on the next call
 * rather than cached.
 */
export function createCachedTokenSource(
  mint: () => Promise<string>,
  opts: { refreshMarginMs?: number; now?: () => number } = {},
): TokenSource {
  const refreshMarginMs = opts.refreshMarginMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let cached: { token: string; expiresAt: number | null } | null = null;
  let inFlight: Promise<string> | null = null;

  const fresh = (): boolean =>
    cached !== null && (cached.expiresAt === null || cached.expiresAt - refreshMarginMs > now());

  return async () => {
    if (fresh()) return cached!.token;
    if (inFlight) return inFlight;
    inFlight = mint()
      .then((token) => {
        cached = { token, expiresAt: jwtExpiryMs(token) };
        return token;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}
