import type { Request, RequestHandler } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { betterAuth, type Auth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { toNodeHandler } from "better-auth/node";
import type { Db } from "@paperclipai/db";
import {
  authAccounts,
  authJwks,
  authSessions,
  authUsers,
  authVerifications,
  instanceUserRoles,
} from "@paperclipai/db";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { buildPrincipalClaims } from "./auth-client.js";
import { logger } from "../middleware/logger.js";

// Maps a better-auth social/OAuth providerId to the OIDC issuer we record in
// user.idp_issuer. Only providers we federate to are listed.
const IDP_ISSUER_BY_PROVIDER: Record<string, string> = {
  google: "https://accounts.google.com",
};

function emailInDomain(email: string | null | undefined, domain: string): boolean {
  const normalized = email?.trim().toLowerCase();
  return Boolean(normalized && normalized.endsWith(`@${domain.toLowerCase()}`));
}

export type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

export type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type BetterAuthGetSessionApi = {
  getSession?: (input: { headers: Headers }) => Promise<unknown>;
};

type BetterAuthHandlerTarget = Extract<Parameters<typeof toNodeHandler>[0], { handler: Auth["handler"] }>;

type BetterAuthSessionResolver = {
  api?: BetterAuthGetSessionApi;
};

type BetterAuthInstance = BetterAuthHandlerTarget & BetterAuthSessionResolver;

const AUTH_COOKIE_PREFIX_FALLBACK = "default";
const AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE = /[^a-zA-Z0-9_-]+/g;

export function deriveAuthCookiePrefix(instanceId = resolvePaperclipInstanceId()): string {
  const scopedInstanceId = instanceId
    .trim()
    .replace(AUTH_COOKIE_PREFIX_INVALID_SEGMENTS_RE, "-")
    .replace(/^-+|-+$/g, "") || AUTH_COOKIE_PREFIX_FALLBACK;
  return `paperclip-${scopedInstanceId}`;
}

export function buildBetterAuthAdvancedOptions(input: { disableSecureCookies: boolean }) {
  return {
    cookiePrefix: deriveAuthCookiePrefix(),
    ...(input.disableSecureCookies ? { useSecureCookies: false } : {}),
  };
}

export function shouldDisableSecureAuthCookies(input: {
  deploymentMode: Config["deploymentMode"];
  deploymentExposure?: Config["deploymentExposure"];
  authBaseUrlMode: Config["authBaseUrlMode"];
  authPublicBaseUrl: string | undefined;
  publicUrl?: string | undefined;
}): boolean {
  const publicUrl = (
    input.publicUrl?.trim() ||
    (input.authBaseUrlMode === "explicit" ? input.authPublicBaseUrl?.trim() : "")
  );
  if (publicUrl) return publicUrl.startsWith("http://");

  return (
    input.deploymentMode === "authenticated" &&
    (
      (input.deploymentExposure === "private" && input.authBaseUrlMode === "auto") ||
      input.deploymentExposure === undefined
    )
  );
}

function headersFromNodeHeaders(rawHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, raw] of Object.entries(rawHeaders)) {
    if (!raw) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(key, value);
      continue;
    }
    headers.set(key, raw);
  }
  return headers;
}

function headersFromExpressRequest(req: Request): Headers {
  return headersFromNodeHeaders(req.headers);
}

export function deriveAuthTrustedOrigins(config: Config, opts?: { listenPort?: number }): string[] {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const trustedOrigins = new Set<string>();

  if (baseUrl) {
    try {
      trustedOrigins.add(new URL(baseUrl).origin);
    } catch {
      // Better Auth will surface invalid base URL separately.
    }
  }
  if (config.deploymentMode === "authenticated") {
    const port = opts?.listenPort ?? config.port;
    const needsPortVariants = port !== 80 && port !== 443;
    for (const hostname of config.allowedHostnames) {
      const trimmed = hostname.trim().toLowerCase();
      if (!trimmed) continue;
      trustedOrigins.add(`https://${trimmed}`);
      trustedOrigins.add(`http://${trimmed}`);
      if (needsPortVariants) {
        trustedOrigins.add(`https://${trimmed}:${port}`);
        trustedOrigins.add(`http://${trimmed}:${port}`);
      }
    }
  }

  return Array.from(trustedOrigins);
}

export function createBetterAuthInstance(db: Db, config: Config, trustedOrigins: string[]): BetterAuthInstance {
  const baseUrl = config.authBaseUrlMode === "explicit" ? config.authPublicBaseUrl : undefined;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() || baseUrl;
  const secret = process.env.BETTER_AUTH_SECRET ?? process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "BETTER_AUTH_SECRET (or PAPERCLIP_AGENT_JWT_SECRET) must be set. " +
      "For local development, set BETTER_AUTH_SECRET=paperclip-dev-secret in your .env file.",
    );
  }
  const disableSecureCookies = shouldDisableSecureAuthCookies({
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    authBaseUrlMode: config.authBaseUrlMode,
    authPublicBaseUrl: config.authPublicBaseUrl,
    publicUrl,
  });

  const authConfig = {
    baseURL: baseUrl,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authUsers,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        jwks: authJwks,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
      disableSignUp: config.authDisableSignUp,
    },
    // Sarala Google (Workspace) SSO. Opt-in: only registered when both client
    // credentials are present (Secret Manager in cloud). idp_issuer/idp_subject
    // are stamped on the linked account (databaseHooks.account.create.after);
    // sign-up is restricted to the configured Workspace domain if set.
    ...(config.authGoogleClientId && config.authGoogleClientSecret
      ? {
          socialProviders: {
            google: {
              clientId: config.authGoogleClientId,
              clientSecret: config.authGoogleClientSecret,
            },
          },
        }
      : {}),
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            if (config.authGoogleAllowedDomain && !emailInDomain(user.email, config.authGoogleAllowedDomain)) {
              throw new APIError("FORBIDDEN", {
                message: `Sign-up is restricted to @${config.authGoogleAllowedDomain} accounts.`,
              });
            }
            return { data: user };
          },
          // Bootstrapped org admins: a fresh instance is claimed by known people,
          // not first-user-wins. If the new user's email is in the configured
          // allowlist, grant instance_admin (idempotent) so they can bootstrap
          // org/company and manage the instance.
          after: async (user: { id: string; email: string }) => {
            const email = user.email?.trim().toLowerCase();
            if (email && config.authOrgAdminEmails.includes(email)) {
              await db
                .insert(instanceUserRoles)
                .values({ userId: user.id, role: "instance_admin" })
                .onConflictDoNothing({ target: [instanceUserRoles.userId, instanceUserRoles.role] });
            }
          },
        },
      },
      account: {
        create: {
          after: async (account: { providerId: string; accountId: string; userId: string }) => {
            const issuer = IDP_ISSUER_BY_PROVIDER[account.providerId];
            if (!issuer) return;
            await db
              .update(authUsers)
              .set({ idpIssuer: issuer, idpSubject: account.accountId })
              .where(eq(authUsers.id, account.userId));
          },
        },
      },
    },
    // Cockpit is the human-identity authority. The jwt plugin makes it mint
    // short-lived APEX principal JWTs and publish its JWKS at /api/auth/jwks so
    // the gateway can verify them locally and enforce (APEX-127 / auth-service.md).
    // The claims ARE the principal contract (buildPrincipalClaims).
    plugins: [
      jwt({
        // Do NOT auto-sign a JWT onto every response (better-auth's own guidance
        // when an OAuth/social provider is in play). Auto-signing runs
        // definePayload -> buildPrincipalClaims on the OAuth sign-in response and
        // was crashing the process (503). The gateway gets JWTs on demand from
        // /api/auth/token + JWKS instead.
        disableSettingJwtHeader: true,
        jwt: {
          ...(publicUrl ? { issuer: publicUrl } : {}),
          audience: "apex-gateway",
          expirationTime: "15m",
          getSubject: ({ user }) => user.id,
          // Defensive: a claims-build failure must never crash the token
          // response — fall back to minimal identity claims.
          definePayload: async ({ user }) => {
            try {
              return await buildPrincipalClaims(db, user.id);
            } catch (err) {
              logger.error({ err, userId: user.id }, "buildPrincipalClaims failed; issuing minimal JWT claims");
              return { email: user.email ?? null };
            }
          },
        },
      }),
    ],
    advanced: buildBetterAuthAdvancedOptions({ disableSecureCookies }),
  };

  if (!baseUrl) {
    delete (authConfig as { baseURL?: string }).baseURL;
  }

  return betterAuth(authConfig);
}

export function createBetterAuthHandler(auth: BetterAuthHandlerTarget): RequestHandler {
  const handler = toNodeHandler(auth);
  return (req, res, next) => {
    void Promise.resolve(handler(req, res)).catch(next);
  };
}

export async function resolveBetterAuthSessionFromHeaders(
  auth: BetterAuthSessionResolver,
  headers: Headers,
): Promise<BetterAuthSessionResult | null> {
  const api = auth.api;
  if (!api?.getSession) return null;

  const sessionValue = await api.getSession({
    headers,
  });
  if (!sessionValue || typeof sessionValue !== "object") return null;

  const value = sessionValue as {
    session?: { id?: string; userId?: string } | null;
    user?: { id?: string; email?: string | null; name?: string | null } | null;
  };
  const session = value.session?.id && value.session.userId
    ? { id: value.session.id, userId: value.session.userId }
    : null;
  const user = value.user?.id
    ? {
        id: value.user.id,
        email: value.user.email ?? null,
        name: value.user.name ?? null,
      }
    : null;

  if (!session || !user) return null;
  return { session, user };
}

export async function resolveBetterAuthSession(
  auth: BetterAuthSessionResolver,
  req: Request,
): Promise<BetterAuthSessionResult | null> {
  return resolveBetterAuthSessionFromHeaders(auth, headersFromExpressRequest(req));
}
