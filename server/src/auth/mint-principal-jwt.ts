import type { Db } from "@paperclipai/db";
import { buildPrincipalClaims } from "./auth-client.js";

/**
 * Structural view of the better-auth instance's server API needed to mint a
 * principal JWT. The concrete instance returned by `createBetterAuthInstance`
 * is typed narrowly (handler + session resolver) but carries `.api.signJWT` at
 * runtime — a `serverOnly` endpoint (never exposed over HTTP), so calling it
 * server-side is safe and needs no session.
 */
export interface PrincipalJwtSigner {
  api: {
    signJWT: (input: {
      body: { payload: Record<string, unknown>; overrideOptions?: Record<string, unknown> };
    }) => Promise<{ token: string } | string>;
  };
}

/**
 * Mint a short-lived, operator-attributed APEX principal JWT for `userId`,
 * signed with cockpit's JWKS key so the gateway verifies it locally (see
 * auth-service.md). The payload IS the principal contract (`buildPrincipalClaims`)
 * plus `sub`; issuer/audience ("apex-gateway")/15m-expiry come from the jwt
 * plugin's own configured options (the endpoint spreads them), so this can never
 * drift from a token minted on a live sign-in.
 *
 * This is the thesis-critical primitive: identity carried into a run is the
 * *operator's*, minted per run and never a static/faceless service token. The
 * caller injects the result into the run env as `APEX_GATEWAY_TOKEN`, where it is
 * redacted, never written to disk, and gone at run end.
 */
export async function mintPrincipalJwtForUser(
  auth: PrincipalJwtSigner,
  db: Db,
  userId: string,
): Promise<string> {
  const claims = await buildPrincipalClaims(db, userId);
  const result = await auth.api.signJWT({
    body: { payload: { ...claims, sub: userId } },
  });
  const token = typeof result === "string" ? result : result?.token;
  if (!token || typeof token !== "string") {
    throw new Error(`principal JWT mint returned no token for user ${userId}`);
  }
  return token;
}
