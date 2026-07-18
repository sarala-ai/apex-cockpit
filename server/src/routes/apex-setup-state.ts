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
import { eq } from "drizzle-orm";
import { type Db, orgs, companies, cloudScopeBindings } from "@paperclipai/db";
import { checkAuth } from "../apex/setup/cloud.js";
import { run } from "../apex/exec.js";
import { assertBoardOrAgent } from "./authz.js";

type Health = "ok" | "missing" | "expired";

export interface SetupState {
  auth: { gcloud: Health; gh: Health; adc: Health };
  org: { present: boolean; id?: string };
  companies: { count: number; ids: string[] };
  scoping: { orgBound: boolean; companyBound: boolean };
  oauthClient: { configured: boolean; note?: string };
  gateway: { reachable: boolean };
  mcpServers: { registered: string[] };
}

export interface SetupStateProbes {
  auth: () => Promise<SetupState["auth"]>;
  org: () => Promise<SetupState["org"]>;
  companies: (orgId?: string) => Promise<SetupState["companies"]>;
  scoping: () => Promise<SetupState["scoping"]>;
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
    async companies(orgId?: string) {
      const rows = orgId
        ? await db.select({ id: companies.id }).from(companies).where(eq(companies.orgId, orgId))
        : await db.select({ id: companies.id }).from(companies);
      return { count: rows.length, ids: rows.map((r) => r.id) };
    },
    async scoping() {
      const rows = await db
        .select({ scopeType: cloudScopeBindings.scopeType })
        .from(cloudScopeBindings);
      return {
        orgBound: rows.some((r) => r.scopeType === "org"),
        companyBound: rows.some((r) => r.scopeType === "company"),
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

    const [auth, org, scoping, oauthClient, gateway] = await Promise.all([
      safe(() => probes.auth(), { gcloud: "missing", gh: "missing", adc: "missing" } as const),
      safe(() => probes.org(), { present: false }),
      safe(() => probes.scoping(), { orgBound: false, companyBound: false }),
      safe(() => probes.oauthClient(), { configured: false, note: "probe failed" }),
      safe(() => probes.gateway(), { reachable: false }),
    ]);
    // companies is org-scoped when we know the org; mcpServers depends on gateway.
    const [companiesState, mcpServers] = await Promise.all([
      safe(() => probes.companies(orgId ?? org.id), { count: 0, ids: [] }),
      safe(() => probes.mcpServers(gateway.reachable), { registered: [] }),
    ]);

    const state: SetupState = {
      auth,
      org,
      companies: companiesState,
      scoping,
      oauthClient,
      gateway,
      mcpServers,
    };
    res.json(state);
  });

  return router;
}
