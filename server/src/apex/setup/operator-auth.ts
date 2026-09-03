import { eq } from "drizzle-orm";
import { type Db, operatorWorkstationReports } from "@paperclipai/db";
import type { WorkstationReport } from "@paperclipai/shared";
import { checkAuth } from "./cloud.js";
import { run } from "../exec.js";

export type OperatorAuthHealth = "ok" | "missing" | "expired";

/**
 * Operator-scoped setup truth. Two sources, chosen by where the cockpit runs:
 * on a local (server == laptop) instance the server probes its own gcloud/gh;
 * on a hosted instance the container's CLIs are NOT the operator's, so the
 * only truth is what the operator's workstation last reported.
 */
export interface OperatorAuthStatus {
  gcloud: OperatorAuthHealth;
  gh: OperatorAuthHealth;
  adc: OperatorAuthHealth;
  google: { authed: boolean; account: string | null; live: boolean };
  github: { authed: boolean; user: string | null; live: boolean };
  source: "server" | "workstation" | "none";
  reportedAt: string | null;
}

export function healthFromReport(report: WorkstationReport): Pick<OperatorAuthStatus, "gcloud" | "gh" | "adc"> {
  const gcloud: OperatorAuthHealth = !report.gcloud.installed || !report.gcloud.account
    ? "missing"
    : report.gcloud.live
      ? "ok"
      : "expired";
  return {
    gcloud,
    gh: report.gh.installed && report.gh.user ? "ok" : "missing",
    adc: report.adc.live ? "ok" : "missing",
  };
}

const NONE: OperatorAuthStatus = {
  gcloud: "missing",
  gh: "missing",
  adc: "missing",
  google: { authed: false, account: null, live: false },
  github: { authed: false, user: null, live: false },
  source: "none",
  reportedAt: null,
};

export function operatorAuthFromWorkstationReport(
  row: { report: WorkstationReport; reportedAt: Date } | null,
): OperatorAuthStatus {
  if (!row) return NONE;
  const { report } = row;
  return {
    ...healthFromReport(report),
    google: {
      authed: report.gcloud.installed && report.gcloud.account !== null,
      account: report.gcloud.account,
      live: report.gcloud.live,
    },
    github: {
      authed: report.gh.installed && report.gh.user !== null,
      user: report.gh.user,
      live: report.gh.installed && report.gh.user !== null,
    },
    source: "workstation",
    reportedAt: row.reportedAt.toISOString(),
  };
}

export async function readWorkstationReport(db: Db, userId: string) {
  const [row] = await db
    .select({ report: operatorWorkstationReports.report, reportedAt: operatorWorkstationReports.reportedAt })
    .from(operatorWorkstationReports)
    .where(eq(operatorWorkstationReports.userId, userId))
    .limit(1);
  return row ? { report: row.report as unknown as WorkstationReport, reportedAt: row.reportedAt } : null;
}

export async function probeServerOperatorAuth(): Promise<OperatorAuthStatus> {
  const status = await checkAuth();
  const adcRes = await run("gcloud", ["auth", "application-default", "print-access-token"], 10000);
  return {
    gcloud: status.google.live ? "ok" : status.google.authed ? "expired" : "missing",
    gh: status.github.live ? "ok" : "missing",
    adc: adcRes.status === "ok" && adcRes.stdout.trim().length > 0 ? "ok" : "missing",
    google: status.google,
    github: status.github,
    source: "server",
    reportedAt: null,
  };
}

export function serverIsOperatorWorkstation(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PAPERCLIP_DEPLOYMENT_MODE ?? "local_trusted") === "local_trusted";
}

export async function resolveOperatorAuth(
  db: Db,
  userId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<OperatorAuthStatus> {
  if (serverIsOperatorWorkstation(env)) return probeServerOperatorAuth();
  if (!userId) return NONE;
  return operatorAuthFromWorkstationReport(await readWorkstationReport(db, userId));
}
