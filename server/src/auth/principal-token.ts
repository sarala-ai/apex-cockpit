/**
 * The `iss`/`aud` contract of cockpit-issued principal JWTs, in a module
 * with no better-auth dependency: the verifier and the actor middleware need
 * these in every deployment mode, while better-auth itself is only loaded on
 * authenticated instances.
 *
 * The one audience every cockpit-issued principal JWT carries. The gateway
 * trusts cockpit as an IdP for exactly this
 * audience, and cockpit accepts its own tokens under it too (the gateway
 * forwards an operator's token back to cockpit-mcp verbatim), so there is
 * one principal token kind, not one per consumer.
 */
export const APEX_PRINCIPAL_AUDIENCE = "apex-gateway";

/** The `iss` the jwt plugin signs with: the configured public URL, else the
 *  explicit auth base URL. `null` means better-auth falls back to its own
 *  baseURL origin — verifiers then skip the issuer check and rely on the
 *  signature against this instance's JWKS alone. */
export function resolvePrincipalJwtIssuer(config: {
  authBaseUrlMode: string;
  authPublicBaseUrl: string | undefined;
}): string | null {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  return process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl || null;
}
