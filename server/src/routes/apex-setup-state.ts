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
import { type Db, orgs, companies, cloudScopeBindings, orgMemberships, companySecrets, userSecretDefinitions } from "@paperclipai/db";
import { resolveOperatorAuth, serverIsOperatorWorkstation } from "../apex/setup/operator-auth.js";
import { assertBoardOrAgent } from "./authz.js";
import { readModelAccessState, type ModelAccessState } from "../apex/model-access/index.js";
import { detectClaudeAuthForOperator, UNKNOWN_CLAUDE_DETECT } from "../apex/model-access/detect-claude.js";
import { cockpitSystemGatewayClient } from "../gateway/system-credential.js";
import { gatewayUrl, type GatewayFailure } from "../gateway/gateway-client.js";

type Health = "ok" | "missing" | "expired";

/** The name the gateway gives its built-in upstream for this cockpit. */
export const COCKPIT_MCP_UPSTREAM_NAME = "cockpit-mcp";

export interface SetupState {
  /** Operator-scoped: `source` says who answered — the server probing itself
   *  (local instance) or the operator's workstation report (hosted); `stale`
   *  is a report past its max age (items carried, never green); `none` means
   *  no report yet. */
  auth: {
    gcloud: Health;
    gh: Health;
    adc: Health;
    source: "server" | "workstation" | "stale" | "none";
    reportedAt: string | null;
    reportAgeMs: number | null;
  };
  /** `posture` is the governance dial (default `individual`) — drives which
   *  hardening steps the wizard requires (see SetupWizard.requiredSteps). */
  org: { present: boolean; id?: string; posture?: "individual" | "team" | "enterprise" };
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
  /** What the cockpit can actually verify about Google OAuth: its own sign-in
   *  client (GOOGLE_CLIENT_ID, the value config.ts reads; not applicable on a
   *  local_trusted instance) and, in the gateway registry, whether every
   *  OAuth-typed upstream carries an OAuth config. `configured` is both. */
  oauthClient: {
    configured: boolean;
    signInClient: "configured" | "missing" | "not_applicable";
    gatewayUpstreams: { total: number; configured: number; error?: string };
    note?: string;
  };
  /** `url` is what this process is configured to call; `authenticated` is
   *  whether the registry read accepted the cockpit's credential (null when
   *  the gateway could not be reached at all). */
  gateway: { reachable: boolean; url: string; authenticated: boolean | null; failure: GatewayFailure | null };
  /** `error` is set when the registry could not be read even though the
   *  gateway is up — typically the cockpit's credential being rejected — so
   *  an empty list is never mistaken for an empty registry. `cockpitMcp` is
   *  the gateway's built-in upstream for this cockpit (the gateway derives it
   *  at boot from its COCKPIT_PUBLIC_URL); a pure read — cockpit never
   *  registers itself. `reachable` is the gateway's own health verdict, null
   *  when it has not reported one. */
  mcpServers: {
    registered: string[];
    error?: string;
    cockpitMcp: {
      registered: boolean;
      reachable: boolean | null;
      url?: string;
    };
  };
  /** Model access — how model calls are paid for and routed. Covers both
   *  provider detection (is claude logged in? is OpenRouter configured?) and
   *  generated artifact presence (is the subscription bridge registered in the
   *  gateway? are the apex-* aliases seeded?). */
  models: ModelAccessState;
  /** Whether the signed-in operator can power remote claude sessions: their
   *  per-user CLAUDE_CODE_OAUTH_TOKEN slot is filled (subscription ceremony —
   *  see .apex/GUIDE-claude-session-setup.md) or a company ANTHROPIC_API_KEY
   *  exists. Consent is manual by Anthropic design; this only DETECTS it. */
  claudeSession: { connected: boolean; source: "subscription_token" | "company_api_key" | null; setAt: string | null };
}

export interface SetupStateProbes {
  auth: (userId: string | null) => Promise<SetupState["auth"]>;
  org: () => Promise<SetupState["org"]>;
  membership: (userId?: string | null, orgId?: string) => Promise<SetupState["membership"]>;
  companies: (orgId?: string) => Promise<SetupState["companies"]>;
  scoping: () => Promise<SetupState["scoping"]>;
  oauthClient: () => Promise<SetupState["oauthClient"]>;
  gateway: () => Promise<SetupState["gateway"]>;
  mcpServers: (gatewayReachable: boolean) => Promise<SetupState["mcpServers"]>;
  models: (userId: string | null) => Promise<SetupState["models"]>;
  claudeSession: (userId: string | null) => Promise<SetupState["claudeSession"]>;
}

/** Real probes over the live DB / gcloud / gateway. Each is self-contained.
 *  Gateway probes run as the cockpit system principal: they describe the
 *  instance, not the signed-in operator. */
export function defaultProbes(
  db: Db,
  gateway = cockpitSystemGatewayClient(),
  env: NodeJS.ProcessEnv = process.env,
): SetupStateProbes {
  return {
    async claudeSession(userId) {
      if (!userId) return { connected: false, source: null, setAt: null };
      const sub = await db
        .select({ updatedAt: companySecrets.updatedAt })
        .from(companySecrets)
        .innerJoin(userSecretDefinitions, eq(companySecrets.userSecretDefinitionId, userSecretDefinitions.id))
        .where(and(
          eq(companySecrets.scope, "user"),
          eq(companySecrets.ownerUserId, userId),
          eq(companySecrets.status, "active"),
          eq(userSecretDefinitions.key, "CLAUDE_CODE_OAUTH_TOKEN"),
        ))
        .limit(1);
      if (sub.length > 0) {
        return { connected: true, source: "subscription_token", setAt: sub[0].updatedAt ? new Date(sub[0].updatedAt).toISOString() : null };
      }
      const apiKey = await db
        .select({ updatedAt: companySecrets.updatedAt })
        .from(companySecrets)
        .where(and(
          eq(companySecrets.scope, "company"),
          eq(companySecrets.key, "ANTHROPIC_API_KEY"),
          eq(companySecrets.status, "active"),
        ))
        .limit(1);
      if (apiKey.length > 0) {
        return { connected: true, source: "company_api_key", setAt: apiKey[0].updatedAt ? new Date(apiKey[0].updatedAt).toISOString() : null };
      }
      return { connected: false, source: null, setAt: null };
    },
    async auth(userId) {
      const status = await resolveOperatorAuth(db, userId, env);
      return {
        gcloud: status.gcloud,
        gh: status.gh,
        adc: status.adc,
        source: status.source,
        reportedAt: status.reportedAt,
        reportAgeMs: status.reportAgeMs,
      };
    },
    async org() {
      const [row] = await db
        .select({ id: orgs.id, posture: orgs.governancePosture })
        .from(orgs)
        .limit(1);
      if (!row) return { present: false };
      const posture =
        row.posture === "team" || row.posture === "enterprise" ? row.posture : "individual";
      return { present: true, id: row.id, posture };
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
    async oauthClient() {
      const signInClient: SetupState["oauthClient"]["signInClient"] = serverIsOperatorWorkstation(env)
        ? "not_applicable"
        : env.GOOGLE_CLIENT_ID?.trim()
          ? "configured"
          : "missing";
      const posture = await gateway.readGatewayOauthPosture();
      if (!posture.ok) {
        return {
          configured: false,
          signInClient,
          gatewayUpstreams: { total: 0, configured: 0, error: posture.failure.message },
          note: "gateway registry could not be read",
        };
      }
      const oauthUpstreams = posture.value.filter((g) => (g.authType ?? "").toLowerCase() === "oauth");
      const gatewayUpstreams = {
        total: oauthUpstreams.length,
        configured: oauthUpstreams.filter((g) => g.oauthConfigured).length,
      };
      const upstreamsOk = gatewayUpstreams.configured === gatewayUpstreams.total;
      return {
        configured: signInClient !== "missing" && upstreamsOk,
        signInClient,
        gatewayUpstreams,
        ...(signInClient === "missing" ? { note: "GOOGLE_CLIENT_ID not set on the cockpit" } : {}),
      };
    },
    async gateway() {
      const probe = await gateway.probe();
      return { reachable: probe.reachable, url: gatewayUrl(), authenticated: probe.authenticated, failure: probe.failure };
    },
    async mcpServers(gatewayReachable: boolean) {
      const absent = { registered: false, reachable: null };
      if (!gatewayReachable) return { registered: [], cockpitMcp: absent };
      const res = await gateway.readGateways();
      if (!res.ok) {
        return { registered: [], error: res.failure.message, cockpitMcp: absent };
      }
      const entry = res.value.find((g) => g.name === COCKPIT_MCP_UPSTREAM_NAME);
      return {
        registered: res.value.map((g) => g.name),
        cockpitMcp: entry
          ? { registered: true, reachable: entry.reachable ?? null, ...(entry.url ? { url: entry.url } : {}) }
          : absent,
      };
    },
    async models(userId) {
      return readModelAccessState(gateway, detectClaudeAuthForOperator(db, userId, env));
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

    const [auth, org, scoping, oauthClient, gateway] = await Promise.all([
      safe(() => probes.auth(req.actor?.userId ?? null), {
        gcloud: "missing",
        gh: "missing",
        adc: "missing",
        source: "none",
        reportedAt: null,
        reportAgeMs: null,
      } as const),
      safe(() => probes.org(), { present: false }),
      safe(() => probes.scoping(), {
        orgProjectsBound: false,
        orgReposBound: false,
        companyProjectsBound: false,
        companyReposBound: false,
      }),
      safe(() => probes.oauthClient(), {
        configured: false,
        signInClient: "missing",
        gatewayUpstreams: { total: 0, configured: 0, error: "probe failed" },
        note: "probe failed",
      }),
      safe(() => probes.gateway(), {
        reachable: false,
        url: gatewayUrl(),
        authenticated: null,
        failure: { kind: "unreachable", status: null, message: "probe failed" },
      }),
    ]);
    // companies + membership are org-scoped once the org is known; mcpServers
    // depends on gateway. Membership resolves the signed-in actor's row.
    // models probe runs in parallel with the secondary probes.
    const resolvedOrgId = orgId ?? org.id;
    const defaultModelsState: ModelAccessState = {
      claude: { ...UNKNOWN_CLAUDE_DETECT, subscriptionProviderRegistered: false, apiKeyProviderRegistered: false },
      openrouter: { configured: false },
      aliasesRegistered: [],
      bridgeAvailable: false,
    };
    const [companiesState, mcpServers, membership, models, claudeSession] = await Promise.all([
      safe(() => probes.companies(resolvedOrgId), { count: 0, ids: [] }),
      safe(() => probes.mcpServers(gateway.reachable), { registered: [], cockpitMcp: { registered: false, reachable: null } }),
      safe(() => probes.membership(req.actor?.userId ?? null, resolvedOrgId), { present: false }),
      safe(() => probes.models(req.actor?.userId ?? null), defaultModelsState),
      safe(() => probes.claudeSession(req.actor?.userId ?? null), { connected: false, source: null, setAt: null } as const),
    ]);

    const state: SetupState = {
      auth,
      org,
      membership,
      companies: companiesState,
      scoping,
      oauthClient,
      gateway,
      mcpServers,
      models,
      claudeSession,
    };
    res.json(state);
  });

  return router;
}
