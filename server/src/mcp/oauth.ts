/**
 * APEX-35 T7 — OAuth 2.1 authorization-code + PKCE flow for external MCP hosts
 * (Claude Code, Cursor, …).
 *
 * Endpoints:
 *   GET  /oauth/authorize — validates the request, requires an authenticated
 *        cockpit session (better-auth), issues a single-use authorization code
 *        and redirects to redirect_uri. Consent UI is out of scope for APEX-35;
 *        an authenticated session implies consent (basic redirect per spec).
 *   POST /oauth/token     — exchanges code + PKCE verifier for a user-scoped
 *        cockpit-mcp JWT accepted by the /mcp auth middleware.
 *
 * Constraints enforced (spec acceptance criteria):
 *   - PKCE is mandatory, S256 only — `plain` or missing challenge → invalid_request.
 *   - RFC 8707 resource indicator is mandatory and must name the cockpit MCP
 *     URI → otherwise invalid_target.
 *   - Codes are single-use, short-lived, bound to client_id + redirect_uri +
 *     resource + challenge.
 *   - Resulting tokens are user-scoped: no run_id, populated user_id, read-only
 *     capability set (writes stay with run identity; gateway attenuation is the
 *     path to more). The single exception is secrets:write, which is off by
 *     default and opt-in per deployment — see SECRETS_WRITE_ENV_FLAG below.
 *
 * The code store is in-memory: the cockpit is a single-process server and codes
 * live for two minutes. Validation errors return direct 400 JSON (not error
 * redirects) — deterministic for headless CI probes; a consent UI can layer
 * redirect-style errors later without changing the contract.
 */
import { createHash, randomBytes } from "node:crypto";
import { Router, urlencoded, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { companyMemberships } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { mintCockpitMcpUserJwt } from "./cockpit-mcp-jwt.js";
import { CAP_BOARD_READ, CAP_SECRETS_WRITE } from "./capabilities.js";

const CODE_TTL_MS = 2 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // informational; the JWT carries exp

/**
 * Opt-in env flag that adds secrets:write to the capability set of a
 * user-scoped MCP session.
 *
 * Why an env flag and not a role check: this flow has no consent screen (see
 * the module doc — an authenticated session implies consent), so there is no
 * point at which a human is shown "this host is asking to mint credentials"
 * and can decline. Until there is one, the decision is made out-of-band by the
 * person who runs the process, on the machine where the Penpot/GCP credentials
 * already live. Default OFF: an external MCP host that merely completes the
 * OAuth flow gets exactly what it got before this change.
 *
 * Runs never reach here at all — mintCockpitMcpJwt strips secrets:write from
 * every run token regardless of this flag.
 */
const SECRETS_WRITE_ENV_FLAG = "PAPERCLIP_MCP_ALLOW_SECRETS_WRITE";

function userSessionCapabilities(): string[] {
  const flag = process.env[SECRETS_WRITE_ENV_FLAG]?.trim().toLowerCase();
  const allowSecretsWrite = flag === "1" || flag === "true";
  return allowSecretsWrite ? [CAP_BOARD_READ, CAP_SECRETS_WRITE] : [CAP_BOARD_READ];
}

interface PendingAuthorization {
  userId: string;
  companyId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
}

export interface OauthRoutesOptions {
  /** Resolve the authenticated cockpit user for this request (better-auth session). */
  resolveUserId: (req: Request) => Promise<string | null>;
  /**
   * Canonical MCP resource URI the `resource` indicator must name. When unset,
   * any absolute http(s) URI whose path is exactly `/mcp` is accepted — the
   * cockpit's public origin varies per deployment.
   */
  expectedResource?: string;
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

function isValidRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isAcceptableResource(value: string, expected: string | undefined): boolean {
  if (expected) return value.replace(/\/$/, "") === expected.replace(/\/$/, "");
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/mcp";
  } catch {
    return false;
  }
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

async function resolveMembershipCompanyId(
  db: Db,
  userId: string,
  requestedCompanyId: string | undefined,
): Promise<string | null> {
  const memberships = await db
    .select({ companyId: companyMemberships.companyId })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
        eq(companyMemberships.status, "active"),
      ),
    );
  const companyIds = memberships.map((m) => m.companyId);
  if (requestedCompanyId) {
    return companyIds.includes(requestedCompanyId) ? requestedCompanyId : null;
  }
  return companyIds.length === 1 ? companyIds[0]! : null;
}

export function oauthRoutes(db: Db, opts: OauthRoutesOptions): Router {
  const router = Router();
  const pendingCodes = new Map<string, PendingAuthorization>();

  function prune(now: number): void {
    for (const [code, entry] of pendingCodes) {
      if (entry.expiresAt <= now) pendingCodes.delete(code);
    }
  }

  router.get("/oauth/authorize", (req, res, next) => {
    (async () => {
      const q = req.query as Record<string, unknown>;
      const str = (k: string): string | undefined =>
        typeof q[k] === "string" && (q[k] as string).length > 0 ? (q[k] as string) : undefined;

      const responseType = str("response_type");
      const clientId = str("client_id");
      const redirectUri = str("redirect_uri");
      const codeChallenge = str("code_challenge");
      const codeChallengeMethod = str("code_challenge_method");
      const resource = str("resource");
      const state = str("state");

      if (responseType !== "code") {
        return oauthError(res, 400, "unsupported_response_type", "response_type must be 'code'");
      }
      if (!clientId) {
        return oauthError(res, 400, "invalid_request", "client_id is required");
      }
      if (!redirectUri || !isValidRedirectUri(redirectUri)) {
        return oauthError(res, 400, "invalid_request", "redirect_uri must be an absolute http(s) URI");
      }
      // PKCE is mandatory, S256 only (OAuth 2.1).
      if (!codeChallenge) {
        return oauthError(res, 400, "invalid_request", "code_challenge is required (PKCE)");
      }
      if (codeChallengeMethod !== "S256") {
        return oauthError(res, 400, "invalid_request", "code_challenge_method must be S256");
      }
      // RFC 8707 resource indicator names the cockpit MCP server.
      if (!resource || !isAcceptableResource(resource, opts.expectedResource)) {
        return oauthError(res, 400, "invalid_target", "resource must name the cockpit MCP URI");
      }

      const userId = await opts.resolveUserId(req);
      if (!userId) {
        return oauthError(res, 401, "access_denied", "authentication required");
      }

      const companyId = await resolveMembershipCompanyId(db, userId, str("company_id"));
      if (!companyId) {
        return oauthError(
          res,
          400,
          "invalid_request",
          "company_id required (user belongs to zero or multiple companies) or membership missing",
        );
      }

      const now = Date.now();
      prune(now);
      const code = randomBytes(32).toString("base64url");
      pendingCodes.set(code, {
        userId,
        companyId,
        clientId,
        redirectUri,
        codeChallenge,
        resource,
        expiresAt: now + CODE_TTL_MS,
      });

      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      if (state) location.searchParams.set("state", state);
      res.redirect(302, location.toString());
    })().catch(next);
  });

  router.post("/oauth/token", urlencoded({ extended: false }), (req, res, next) => {
    (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const str = (k: string): string | undefined =>
        typeof body[k] === "string" && (body[k] as string).length > 0
          ? (body[k] as string)
          : undefined;

      if (str("grant_type") !== "authorization_code") {
        return oauthError(res, 400, "unsupported_grant_type", "grant_type must be authorization_code");
      }
      const code = str("code");
      const codeVerifier = str("code_verifier");
      const clientId = str("client_id");
      const redirectUri = str("redirect_uri");
      const resource = str("resource");
      if (!code || !codeVerifier || !clientId || !redirectUri) {
        return oauthError(
          res,
          400,
          "invalid_request",
          "code, code_verifier, client_id and redirect_uri are required",
        );
      }

      const now = Date.now();
      prune(now);
      const pending = pendingCodes.get(code);
      // Single-use: consume before validating so a failed exchange burns the code.
      if (pending) pendingCodes.delete(code);

      if (!pending || pending.expiresAt <= now) {
        return oauthError(res, 400, "invalid_grant", "authorization code is invalid or expired");
      }
      if (pending.clientId !== clientId || pending.redirectUri !== redirectUri) {
        return oauthError(res, 400, "invalid_grant", "client_id/redirect_uri mismatch");
      }
      if (resource && resource.replace(/\/$/, "") !== pending.resource.replace(/\/$/, "")) {
        return oauthError(res, 400, "invalid_target", "resource does not match the authorization request");
      }
      if (s256(codeVerifier) !== pending.codeChallenge) {
        return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      }

      const grantedCapabilities = userSessionCapabilities();
      const accessToken = mintCockpitMcpUserJwt({
        userId: pending.userId,
        companyId: pending.companyId,
        grantedCapabilities,
      });
      if (!accessToken) {
        return oauthError(res, 500, "server_error", "token signing is not configured");
      }

      res.status(200).json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        scope: grantedCapabilities.join(" "),
      });
    })().catch(next);
  });

  return router;
}
