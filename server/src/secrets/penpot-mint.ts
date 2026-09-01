/**
 * Server-side Penpot access-token minting.
 *
 * The contract this module exists to keep: the minted VALUE is returned to one
 * in-process caller (mcp/secrets-tools.ts, which hands it straight to the
 * secret store) and to nothing else. It is never logged, never put in an error
 * message, and never placed in a tool result. Every failure below reports the
 * status code and the SHAPE of the response, never its contents — the incident
 * that motivated this module was a raw response body echoed into a transcript
 * because a "looks malformed?" guard misfired on transit+json.
 *
 * Wire protocol, verified against Penpot 2.16:
 *   POST /api/rpc/command/login-with-password  {email, password}
 *     → 200 + `Set-Cookie: auth-token=…` (the session)
 *   POST /api/rpc/command/create-access-token  {name}   (cookie required)
 *     → 200 + transit+json map: ~:id, ~:token, ~:name, ~:created-at
 * Omitting an expiration yields a NON-EXPIRING token, and the response then
 * carries no ~:expires-at at all.
 */
import { penpotBaseUrl, penpotCredentials } from "../design/penpot-config.js";
import { parseTransitMap, requireTransitString, TransitParseError } from "./transit-json.js";

export type PenpotMintErrorCode =
  | "penpot_login_failed"
  | "penpot_mint_failed"
  | "penpot_response_malformed"
  | "penpot_unreachable";

/** Classified mint failure. Carries no part of any response body. */
export class PenpotMintError extends Error {
  constructor(
    public readonly code: PenpotMintErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PenpotMintError";
  }
}

export interface PenpotMintSpec {
  /** Human-facing label shown in Penpot's "Access tokens" settings page. */
  tokenName: string;
  /**
   * ISO-8601 instant after which Penpot should reject the token. OPTIONAL, and
   * omitted by default on purpose: an agent credential that silently expires
   * mid-run fails as a confusing mid-flight 401 inside somebody else's work,
   * whereas a long-lived token is revocable on demand from the same settings
   * page and from this same API. We prefer the failure mode an operator can
   * see and act on over the one that surfaces as a flaky agent.
   */
  expiresAt?: string;
}

export interface MintedCredential {
  /** The credential itself. Goes directly into the secret store. Never returned
   *  to a caller across a transcript boundary — see the module doc. */
  value: string;
  /** Non-sensitive metadata, safe to audit: the provider-side token id and the
   *  expiry it actually got (null = non-expiring). */
  credentialId: string;
  expiresAt: string | null;
}

async function postJson(url: string, body: unknown, cookie?: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new PenpotMintError(
      "penpot_unreachable",
      `cannot reach Penpot at ${penpotBaseUrl()} — check APEX_PENPOT_URL and that the instance is running`,
      { cause: err },
    );
  }
}

/**
 * Log in with the configured service account and return the session cookie.
 * Kept private: a session cookie is itself a credential and no caller outside
 * this module has a use for one.
 */
async function loginForSession(base: string): Promise<string> {
  const { email, password } = penpotCredentials();
  const res = await postJson(`${base}/api/rpc/command/login-with-password`, { email, password });
  if (!res.ok) {
    // 400/401 here is nearly always a wrong APEX_PENPOT_EMAIL/PASSWORD pair;
    // say so rather than making the operator guess from a bare status.
    throw new PenpotMintError(
      "penpot_login_failed",
      `Penpot login failed with HTTP ${res.status} for the account configured in APEX_PENPOT_EMAIL — ` +
        `verify APEX_PENPOT_EMAIL/APEX_PENPOT_PASSWORD against ${base}`,
    );
  }
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) {
    throw new PenpotMintError(
      "penpot_login_failed",
      `Penpot login returned HTTP ${res.status} but no session cookie — the instance at ${base} ` +
        `may be behind a proxy that strips Set-Cookie`,
    );
  }
  return cookie;
}

/**
 * Mint a Penpot access token server-side.
 *
 * @throws PenpotConfigError when credentials are unset, PenpotMintError for
 *   every transport/protocol failure. Never returns a partial result: if the
 *   response cannot be decoded into a real token string, this throws rather
 *   than handing back something token-shaped.
 */
export async function mintPenpotAccessToken(spec: PenpotMintSpec): Promise<MintedCredential> {
  const base = penpotBaseUrl();
  const cookie = await loginForSession(base);

  const payload: Record<string, unknown> = { name: spec.tokenName };
  // Penpot 2.16 accepts an expiration on create-access-token; omitting the key
  // entirely (not sending null) is what produces a non-expiring token.
  if (spec.expiresAt) payload["expires-at"] = spec.expiresAt;

  const res = await postJson(`${base}/api/rpc/command/create-access-token`, payload, cookie);
  if (!res.ok) {
    throw new PenpotMintError(
      "penpot_mint_failed",
      `Penpot create-access-token failed with HTTP ${res.status} at ${base} — ` +
        `the session authenticated, so this is an API-contract or permission problem, not credentials`,
    );
  }

  // The body is transit+json, NOT json — decode it, never inspect it as text.
  let decoded: Record<string, unknown>;
  try {
    decoded = parseTransitMap(await res.json());
  } catch (err) {
    if (err instanceof TransitParseError) {
      throw new PenpotMintError(
        "penpot_response_malformed",
        `Penpot create-access-token returned a body this server cannot decode (${err.code}: ${err.message}); ` +
          `the response was NOT logged because it would contain the minted token`,
        { cause: err },
      );
    }
    throw new PenpotMintError(
      "penpot_response_malformed",
      "Penpot create-access-token returned a body that is not valid JSON; the response was NOT logged " +
        "because it would contain the minted token",
      { cause: err },
    );
  }

  let value: string;
  let credentialId: string;
  try {
    value = requireTransitString(decoded, "token");
    credentialId = requireTransitString(decoded, "id");
  } catch (err) {
    throw new PenpotMintError(
      "penpot_response_malformed",
      `Penpot create-access-token returned a decodable map without a usable token/id ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }

  const expires = decoded["expires-at"];
  return {
    value,
    credentialId,
    expiresAt: typeof expires === "string" && expires.length > 0 ? expires : null,
  };
}
