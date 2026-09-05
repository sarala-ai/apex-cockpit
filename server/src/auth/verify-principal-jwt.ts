/**
 * Verifies cockpit-issued principal JWTs (the EdDSA tokens the better-auth
 * jwt plugin mints: operator tokens from mint-principal-jwt.ts and the
 * cockpit-system token from mint-system-jwt.ts) with
 * the cockpit's OWN keys — the same JWKS the gateway fetches from
 * /api/auth/jwks, read in-process instead. One auth authority, one key set,
 * two verifiers (gateway and cockpit) that agree by construction.
 *
 * Verification is signature + `exp`/`nbf` + audience + (when configured)
 * issuer. Only the Ed25519 `EdDSA` algorithm the plugin signs with is
 * accepted; the run-scoped HS256 tokens of cockpit-mcp-jwt.ts are a
 * different token kind and never reach this verifier.
 */
import { createPublicKey, verify as cryptoVerify, type JsonWebKey, type KeyObject } from "node:crypto";
import { APEX_PRINCIPAL_AUDIENCE } from "./principal-token.js";
import type { PrincipalClaims, PrincipalCompanyScope } from "./auth-client.js";

export type PrincipalKind = "operator" | "cockpit_system";

export interface VerifiedPrincipal {
  sub: string;
  /** Absent on operator tokens (mint-principal-jwt.ts sets none); the
   *  system principal stamps its own. */
  principalKind: PrincipalKind;
  email: string | null;
  instanceAdmin: boolean;
  companyId: string | null;
  companies: PrincipalCompanyScope[];
  teams: string[];
  iss: string | null;
  exp: number;
}

export type PrincipalJwtVerifyResult =
  | { ok: true; principal: VerifiedPrincipal }
  | {
      ok: false;
      reason: "malformed" | "unknown_key" | "bad_signature" | "expired" | "not_yet_valid" | "wrong_audience" | "wrong_issuer";
    };

export interface PrincipalJwtVerifier {
  verify(token: string): Promise<PrincipalJwtVerifyResult>;
}

export interface PrincipalJwks {
  keys: Array<JsonWebKey & { kid?: string; alg?: string }>;
}

export interface PrincipalJwtVerifierOptions {
  /** The instance's current JWKS — `auth.api.getJwks()` in production. */
  getJwks: () => Promise<PrincipalJwks>;
  /** Expected `iss`; null skips the issuer check (see resolvePrincipalJwtIssuer). */
  issuer: string | null;
  audience?: string;
  now?: () => number;
  /** Floor between JWKS re-reads triggered by an unknown `kid`, so a flood of
   *  garbage tokens cannot turn into a flood of key reads. */
  unknownKidRefetchMinMs?: number;
}

/** Only `alg` matters for our own keys — the plugin signs Ed25519 EdDSA and
 *  nothing else, so anything else is not a principal token. */
const ACCEPTED_ALG = "EdDSA";

/** `kid` and `alg` from a compact JWT's protected header; null if unparseable. */
export function decodeJwtHeader(token: string): { alg?: string; kid?: string } | null {
  const segment = token.split(".")[0];
  if (!segment) return null;
  try {
    const header = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
    return header && typeof header === "object"
      ? {
          alg: typeof header.alg === "string" ? header.alg : undefined,
          kid: typeof header.kid === "string" ? header.kid : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

/** Unverified `iss` from a compact JWT's payload; null when absent/unparseable. */
export function jwtIssuer(token: string): string | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as { iss?: unknown };
    return typeof payload.iss === "string" && payload.iss ? payload.iss : null;
  } catch {
    return null;
  }
}

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((a) => a === expected);
  return false;
}

function toPrincipal(payload: Record<string, unknown>, exp: number): VerifiedPrincipal | null {
  const sub = typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  if (!sub) return null;
  const kindRaw = payload.principalKind;
  const principalKind: PrincipalKind = kindRaw === "cockpit_system" ? "cockpit_system" : "operator";
  const claims = payload as Partial<PrincipalClaims>;
  return {
    sub,
    principalKind,
    email: typeof claims.email === "string" ? claims.email : null,
    instanceAdmin: claims.instanceAdmin === true,
    companyId: typeof claims.companyId === "string" ? claims.companyId : null,
    companies: Array.isArray(claims.companies) ? claims.companies : [],
    teams: Array.isArray(claims.teams) ? claims.teams.filter((t): t is string => typeof t === "string") : [],
    iss: typeof payload.iss === "string" ? payload.iss : null,
    exp,
  };
}

export function createPrincipalJwtVerifier(opts: PrincipalJwtVerifierOptions): PrincipalJwtVerifier {
  const audience = opts.audience ?? APEX_PRINCIPAL_AUDIENCE;
  const now = opts.now ?? Date.now;
  const refetchFloorMs = opts.unknownKidRefetchMinMs ?? 30_000;
  const expectedIssuer = opts.issuer ? normalizeIssuer(opts.issuer) : null;

  let keysByKid = new Map<string, KeyObject>();
  let lastLoadAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  async function loadKeys(): Promise<void> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const jwks = await opts.getJwks();
      const next = new Map<string, KeyObject>();
      for (const jwk of jwks.keys ?? []) {
        if (!jwk.kid) continue;
        if ((jwk.alg ?? ACCEPTED_ALG) !== ACCEPTED_ALG) continue;
        try {
          next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
        } catch {
          // A key we cannot import is a key we cannot trust; skip it rather
          // than fail every verification because of one bad row.
        }
      }
      keysByKid = next;
      lastLoadAt = now();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function keyFor(kid: string): Promise<KeyObject | null> {
    let key = keysByKid.get(kid);
    if (key) return key;
    // Unknown kid: the plugin may have rotated since our last read. One
    // re-read, rate-limited — a token with a made-up kid stays unknown.
    if (now() - lastLoadAt >= refetchFloorMs) {
      await loadKeys();
      key = keysByKid.get(kid);
    }
    return key ?? null;
  }

  return {
    async verify(token: string): Promise<PrincipalJwtVerifyResult> {
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "malformed" };
      const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
      const header = decodeJwtHeader(token);
      if (!header || header.alg !== ACCEPTED_ALG || !header.kid) return { ok: false, reason: "malformed" };

      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as unknown;
        if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };
        payload = parsed as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "malformed" };
      }

      const key = await keyFor(header.kid);
      if (!key) return { ok: false, reason: "unknown_key" };

      let signatureOk = false;
      try {
        signatureOk = cryptoVerify(
          null,
          Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
          key,
          Buffer.from(sigB64, "base64url"),
        );
      } catch {
        signatureOk = false;
      }
      if (!signatureOk) return { ok: false, reason: "bad_signature" };

      const nowSec = Math.floor(now() / 1000);
      const exp = typeof payload.exp === "number" ? payload.exp : null;
      if (exp === null || exp <= nowSec) return { ok: false, reason: "expired" };
      if (typeof payload.nbf === "number" && payload.nbf > nowSec) return { ok: false, reason: "not_yet_valid" };
      if (!audienceMatches(payload.aud, audience)) return { ok: false, reason: "wrong_audience" };
      if (expectedIssuer !== null) {
        const iss = typeof payload.iss === "string" ? normalizeIssuer(payload.iss) : null;
        if (iss !== expectedIssuer) return { ok: false, reason: "wrong_issuer" };
      }

      const principal = toPrincipal(payload, exp);
      if (!principal) return { ok: false, reason: "malformed" };
      return { ok: true, principal };
    },
  };
}
