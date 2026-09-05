/**
 * Org-facts aggregator (the Veil).
 *
 * Flattens everything the Veil's due() rules (packages/shared/src/surfaces.ts)
 * need to know about one org into one `OrgFacts` snapshot. Every source is
 * independently probed and failure-isolated (the `safe()` pattern from
 * server/src/routes/apex-setup-state.ts, reimplemented locally so this module
 * has no import-time dependency on that route file beyond its exported
 * `defaultProbes`) — a dead DB table or an unreachable gateway degrades that
 * field only, never breaks the whole snapshot.
 *
 * `openPrCount` reads the local `~/.apex-tower/runs.json` working store
 * (server/src/apex/pipeline/store.ts). That store is single-instance and not
 * org-scoped, so it is folded into every org's snapshot as-is until
 * pipeline_cases carries a durable PR-link column of its own.
 */

import { gatewayClientForUser } from "../gateway/operator-gateway-client.js";
import { GatewayClient } from "../gateway/gateway-client.js";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  type Db,
  companies,
  companyMemberships,
  goals,
  heartbeatRuns,
  orgMemberships,
  releases,
} from "@paperclipai/db";
import type { OrgFacts } from "@paperclipai/shared";
import { defaultProbes } from "../routes/apex-setup-state.js";
import { readWorkstationReport, workstationReportIsStale } from "../apex/setup/operator-auth.js";
import { JsonWorkingStore } from "../apex/pipeline/store.js";

/** Runs still in flight — matches MAX_TURN_CONTINUATION_LIVE_RUN_STATUSES'
 *  vocabulary (server/src/services/heartbeat.ts). */
const LIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;
/** Runs that reached a terminal status — everything NOT in LIVE_RUN_STATUSES. */
const TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export interface OrgFactsProbes {
  /** At least one repo or GCP project bound at org or company scope
   *  (delegates to defaultProbes().scoping — see module doc). */
  hasRepoOrCloudBinding: () => Promise<boolean>;
  /** heartbeat_runs joined through companies.orgId. */
  runs: (orgId: string) => Promise<{ started: number; completed: number; firstRunAt: string | null; live: number }>;
  /** Open PRs from the local pipeline working store (see module doc). */
  openPrCount: () => Promise<number>;
  /** releases.releasedAt is set, joined through companies.orgId. */
  deploysLanded: (orgId: string) => Promise<number>;
  /** At least one gateway call is in the gateway's own audit ledger. */
  gatewayCallAudited: (userId: string | null) => Promise<boolean>;
  /** Active org_memberships rows for this org. */
  orgMemberCount: (orgId: string) => Promise<number>;
  /** Active company_memberships rows across this org's companies. */
  companyMemberCount: (orgId: string) => Promise<number>;
  /** goals rows across this org's companies. */
  goalCount: (orgId: string) => Promise<number>;
  /** True when the signed-in operator's workstation auth report (or, for a
   *  local instance, the server's own probe) shows a healthy, non-stale
   *  gcloud/gh/adc posture. */
  operatorAuthHealthy: (userId: string | null) => Promise<boolean>;
}

/** Real probes over the live DB / gateway. Injectable so computeOrgFacts is
 *  testable without a live DB (see server/src/__tests__/org-facts.test.ts). */
export function defaultOrgFactsProbes(db: Db, userId: string | null = null): OrgFactsProbes {
  const setupProbes = defaultProbes(db, gatewayClientForUserOrEnv(userId));
  return {
    async hasRepoOrCloudBinding() {
      const s = await setupProbes.scoping();
      return s.orgProjectsBound || s.orgReposBound || s.companyProjectsBound || s.companyReposBound;
    },
    async runs(orgId) {
      const rows = await db
        .select({ status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt })
        .from(heartbeatRuns)
        .innerJoin(companies, eq(heartbeatRuns.companyId, companies.id))
        .where(eq(companies.orgId, orgId));
      const started = rows.length;
      const completed = rows.filter((r) => (TERMINAL_RUN_STATUSES as readonly string[]).includes(r.status)).length;
      const live = rows.filter((r) => (LIVE_RUN_STATUSES as readonly string[]).includes(r.status)).length;
      const firstRunAt = rows.reduce<string | null>((min, r) => {
        if (!r.createdAt) return min;
        const iso = new Date(r.createdAt).toISOString();
        return !min || iso < min ? iso : min;
      }, null);
      return { started, completed, firstRunAt, live };
    },
    async openPrCount() {
      const store = new JsonWorkingStore();
      const runs = await store.list();
      return runs.filter((r) => !!r.prUrl && r.stage !== "done" && r.stage !== "failed").length;
    },
    async deploysLanded(orgId) {
      const rows = await db
        .select({ id: releases.id })
        .from(releases)
        .innerJoin(companies, eq(releases.companyId, companies.id))
        .where(and(eq(companies.orgId, orgId), isNotNull(releases.releasedAt)));
      return rows.length;
    },
    async gatewayCallAudited(userId) {
      if (!userId) return false;
      const { gatewayClientForUser } = await import("../gateway/operator-gateway-client.js");
      const entries = await gatewayClientForUser(userId).listAudit(1);
      return entries.length > 0;
    },
    async orgMemberCount(orgId) {
      const rows = await db
        .select({ id: orgMemberships.id })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.status, "active")));
      return rows.length;
    },
    async companyMemberCount(orgId) {
      const rows = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .innerJoin(companies, eq(companyMemberships.companyId, companies.id))
        .where(and(eq(companies.orgId, orgId), eq(companyMemberships.status, "active")));
      return rows.length;
    },
    async goalCount(orgId) {
      const rows = await db
        .select({ id: goals.id })
        .from(goals)
        .innerJoin(companies, eq(goals.companyId, companies.id))
        .where(eq(companies.orgId, orgId));
      return rows.length;
    },
    async operatorAuthHealthy(userId) {
      if (!userId) return false;
      const row = await readWorkstationReport(db, userId);
      if (!row) return false;
      if (workstationReportIsStale(row)) return false;
      const h = row.report;
      return h.gcloud.live === true && !!h.gh.user;
    },
  };
}

const EMPTY_RUNS = { started: 0, completed: 0, firstRunAt: null as string | null, live: 0 };

function gatewayClientForUserOrEnv(userId: string | null): GatewayClient {
  return userId ? gatewayClientForUser(userId) : new GatewayClient();
}

export async function computeOrgFacts(
  db: Db,
  ctx: { orgId: string; userId?: string | null },
  overrides?: Partial<OrgFactsProbes>,
): Promise<OrgFacts> {
  const probes: OrgFactsProbes = { ...defaultOrgFactsProbes(db, ctx.userId ?? null), ...overrides };
  const [
    hasRepoOrCloudBinding,
    runs,
    openPrCount,
    deploysLanded,
    gatewayCallAudited,
    orgMemberCount,
    companyMemberCount,
    goalCount,
    operatorAuthHealthy,
  ] = await Promise.all([
    safe(() => probes.hasRepoOrCloudBinding(), false),
    safe(() => probes.runs(ctx.orgId), EMPTY_RUNS),
    safe(() => probes.openPrCount(), 0),
    safe(() => probes.deploysLanded(ctx.orgId), 0),
    safe(() => probes.gatewayCallAudited(ctx.userId ?? null), false),
    safe(() => probes.orgMemberCount(ctx.orgId), 0),
    safe(() => probes.companyMemberCount(ctx.orgId), 0),
    safe(() => probes.goalCount(ctx.orgId), 0),
    safe(() => probes.operatorAuthHealthy(ctx.userId ?? null), false),
  ]);

  return {
    asOf: new Date().toISOString(),
    hasRepoOrCloudBinding,
    runsStarted: runs.started,
    runsCompleted: runs.completed,
    firstRunAt: runs.firstRunAt,
    liveRunCount: runs.live,
    openPrCount,
    deploysLanded,
    gatewayCallAudited,
    orgMemberCount,
    companyMemberCount,
    goalCount,
    operatorAuthHealthy,
  };
}
