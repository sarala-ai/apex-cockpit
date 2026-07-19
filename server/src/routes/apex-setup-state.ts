/**
 * Onboarding-wizard detector (apex-tower — see docs/APEX_TOWER_ONBOARDING_WIZARD.md).
 *
 * `GET /setup/state` aggregates the setup prerequisites into one non-throwing
 * snapshot so the wizard UI can render a live checklist. Each sub-probe is
 * independent and failure-isolated: a dead gateway or missing gcloud degrades
 * that field only, never 500s the endpoint (error-handling principle — classify
 * + surface, never swallow-and-crash).
 *
 * Probes are injectable so the route is testable without a live gcloud/gateway/DB;
 * real defaults are built from `db` + the existing `checkAuth`/`run` helpers.
 */

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { type Db, orgs, companies, cloudScopeBindings, orgMemberships } from "@paperclipai/db";
import { checkAuth } from "../apex/setup/cloud.js";
import { run } from "../apex/exec.js";
import { assertBoardOrAgent } from "./authz.js";

type Health = "ok" | "missing" | "expired";

export interface SetupState {
  auth: { gcloud: Health; gh: Health; adc: Health };
  org: { present: boolean; id?: string };
  /** The signed-in user's membership in the detected org. `present:false` when
   *  they have no row (org exists but they're unmapped → request-access branch),
   *  or when there's no org yet (bootstrap-as-owner branch). */
  membership: { role?: string; status?: string; present: boolean };
  companies: { count: number; ids: string[] };
  /** Cloud/repo binding presence, split by scope + kind so the org→company
   *  spine's steps each detect independently (org-cloud vs company-cloud vs
   *  company-repos). "Bound" = at least one non-empty binding at that scope. */
  scoping: {
    orgProjectsBound: boolean;
    orgReposBound: boolean;
    companyProjectsBound: boolean;
    companyReposBound: boolean;
  };
  /** Org-level GitHub connection: the GitHub App install + the single org WIF
   *  pool/provider. SHALLOW probe — presence of config/env markers only; a deep
   *  check (App install liveness, WIF binding) is a later APEX workflow. */
  orgGithub: { appInstalled: boolean; wifConfigured: boolean };
  oauthClient: { configured: boolean; note?: string };
  gateway: { reachable: boolean };
  mcpServers: { registered: string[] };
}

export interface SetupStateProbes {
  auth: () => Promise<SetupState["auth"]>;
  org: () => Promise<SetupState["org"]>;
  membership: (userId?: string | null, orgId?: string) => Promise<SetupState["membership"]>;
  companies: (orgId?: string) => Promise<SetupState["companies"]>;
  scoping: () => Promise<SetupState["scoping"]>;
  orgGithub: () => Promise<SetupState["orgGithub"]>;
  oauthClient: () => Promise<SetupState["oauthClient"]>;
  gateway: () => Promise<SetupState["gateway"]>;
  mcpServers: (gatewayReachable: boolean) => Promise<SetupState["mcpServers"]>;
}

const gatewayUrl = (): string =>
  (process.env.APEX_GATEWAY_URL ?? "http://127.0.0.1:4444").replace(/\/$/, "");

async function timedFetch(url: string, init?: RequestInit, timeoutMs = 3000): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Real probes over the live DB / gcloud / gateway. Each is self-contained. */
export function defaultProbes(db: Db): SetupStateProbes {
  return {
    async auth() {
      const status = await checkAuth();
      const gcloud: Health = status.google.live
        ? "ok"
        : status.google.authed
          ? "expired"
          : "missing";
      const gh: Health = status.github.live ? "ok" : "missing";
      const adcRes = await run("gcloud", ["auth", "application-default", "print-access-token"], 10000);
      const adc: Health = adcRes.status === "ok" && adcRes.stdout.trim().length > 0 ? "ok" : "missing";
      return { gcloud, gh, adc };
    },
    async org() {
      const [row] = await db.select({ id: orgs.id }).from(orgs).limit(1);
      return row ? { present: true, id: row.id } : { present: false };
    },
    async membership(userId?: string | null, orgId?: string) {
      if (!userId || !orgId) return { present: false };
      const [row] = await db
        .select({ role: orgMemberships.role, status: orgMemberships.status })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.userId, userId)))
        .limit(1);
      return row ? { present: true, role: row.role, status: row.status } : { present: false };
    },
    async companies(orgId?: string) {
      const rows = orgId
        ? await db.select({ id: companies.id }).from(companies).where(eq(companies.orgId, orgId))
        : await db.select({ id: companies.id }).from(companies);
      return { count: rows.length, ids: rows.map((r) => r.id) };
    },
    async scoping() {
      const rows = await db
        .select({
          scopeType: cloudScopeBindings.scopeType,
          gcpProjects: cloudScopeBindings.gcpProjects,
          githubRepos: cloudScopeBindings.githubRepos,
        })
        .from(cloudScopeBindings);
      const nonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
      return {
        orgProjectsBound: rows.some((r) => r.scopeType === "org" && nonEmpty(r.gcpProjects)),
        orgReposBound: rows.some((r) => r.scopeType === "org" && nonEmpty(r.githubRepos)),
        companyProjectsBound: rows.some((r) => r.scopeType === "company" && nonEmpty(r.gcpProjects)),
        companyReposBound: rows.some((r) => r.scopeType === "company" && nonEmpty(r.githubRepos)),
      };
    },
    async orgGithub() {
      // Shallow: presence of a stored GitHub App id + org WIF provider in
      // config/env. Deeper verification (App installation, WIF pool binding) is
      // a later APEX workflow — see the Org-GitHub wizard step.
      return {
        appInstalled: Boolean(process.env.GITHUB_APP_ID),
        wifConfigured: Boolean(process.env.GCP_WIF_PROVIDER),
      };
    },
    async oauthClient() {
      // Best-effort: the gateway's Google OAuth client is configured via env today.
      // No signal yet → not configured (with a note), rather than a hard failure.
      const configured = Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID);
      return configured
        ? { configured: true }
        : { configured: false, note: "GOOGLE_OAUTH_CLIENT_ID not set" };
    },
    async gateway() {
      const res = await timedFetch(`${gatewayUrl()}/health`);
      return { reachable: res.ok };
    },
    async mcpServers(gatewayReachable: boolean) {
      if (!gatewayReachable) return { registered: [] };
      const token = process.env.APEX_GATEWAY_TOKEN;
      const res = await timedFetch(`${gatewayUrl()}/gateways`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return { registered: [] };
      const body = (await res.json()) as unknown;
      const list = Array.isArray(body) ? body : [];
      const registered = list
        .map((g) => (g && typeof g === "object" ? (g as { name?: unknown }).name : undefined))
        .filter((n): n is string => typeof n === "string");
      return { registered };
    },
  };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export function apexSetupStateRoutes(db: Db, overrides?: Partial<SetupStateProbes>) {
  const probes: SetupStateProbes = { ...defaultProbes(db), ...overrides };
  const router = Router();

  // GET /setup/state — one failure-isolated snapshot of every prerequisite.
  router.get("/setup/state", async (req, res) => {
    assertBoardOrAgent(req);
    const orgId = typeof req.query.orgId === "string" ? req.query.orgId : undefined;

    const [auth, org, scoping, orgGithub, oauthClient, gateway] = await Promise.all([
      safe(() => probes.auth(), { gcloud: "missing", gh: "missing", adc: "missing" } as const),
      safe(() => probes.org(), { present: false }),
      safe(() => probes.scoping(), {
        orgProjectsBound: false,
        orgReposBound: false,
        companyProjectsBound: false,
        companyReposBound: false,
      }),
      safe(() => probes.orgGithub(), { appInstalled: false, wifConfigured: false }),
      safe(() => probes.oauthClient(), { configured: false, note: "probe failed" }),
      safe(() => probes.gateway(), { reachable: false }),
    ]);
    // companies + membership are org-scoped once the org is known; mcpServers
    // depends on gateway. Membership resolves the signed-in actor's row.
    const resolvedOrgId = orgId ?? org.id;
    const [companiesState, mcpServers, membership] = await Promise.all([
      safe(() => probes.companies(resolvedOrgId), { count: 0, ids: [] }),
      safe(() => probes.mcpServers(gateway.reachable), { registered: [] }),
      safe(() => probes.membership(req.actor?.userId ?? null, resolvedOrgId), { present: false }),
    ]);

    const state: SetupState = {
      auth,
      org,
      membership,
      companies: companiesState,
      scoping,
      orgGithub,
      oauthClient,
      gateway,
      mcpServers,
    };
    res.json(state);
  });

  return router;
}
