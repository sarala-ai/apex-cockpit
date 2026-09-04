import { describe, expect, it } from "vitest";
import {
  WORKSTATION_REPORT_MAX_AGE_MS,
  healthFromReport,
  operatorAuthFromWorkstationReport,
  serverIsOperatorWorkstation,
  summarizeWorkstationReport,
} from "../apex/setup/operator-auth.js";

const report = {
  gcloud: { installed: true, account: "op@sarala.ai", live: false },
  adc: { live: true },
  gh: { installed: true, user: "operator" },
  claude: { installed: true },
  apex: { installed: true, version: "0.9.0" },
};

describe("operator auth from workstation reports", () => {
  it("maps a report to per-item health", () => {
    expect(healthFromReport(report)).toEqual({ gcloud: "expired", gh: "ok", adc: "ok" });
    expect(healthFromReport({ ...report, gcloud: { installed: false, account: null, live: false } }).gcloud).toBe("missing");
    expect(healthFromReport({ ...report, gcloud: { installed: true, account: null, live: false } }).gcloud).toBe("missing");
    expect(healthFromReport({ ...report, gh: { installed: true, user: null } }).gh).toBe("missing");
    expect(healthFromReport({ ...report, adc: { live: false } }).adc).toBe("missing");
  });

  it("carries the report's source and time; no report means unknown, not failing", () => {
    const reportedAt = new Date("2026-09-03T04:00:00Z");
    const now = reportedAt.getTime() + 60_000;
    const status = operatorAuthFromWorkstationReport({ report, reportedAt }, now);
    expect(status.source).toBe("workstation");
    expect(status.reportedAt).toBe("2026-09-03T04:00:00.000Z");
    expect(status.reportAgeMs).toBe(60_000);
    expect(status.google).toEqual({ authed: true, account: "op@sarala.ai", live: false });
    expect(status.github).toEqual({ authed: true, user: "operator", live: true });

    const none = operatorAuthFromWorkstationReport(null);
    expect(none.source).toBe("none");
    expect(none.reportedAt).toBeNull();
    expect([none.gcloud, none.gh, none.adc]).toEqual(["missing", "missing", "missing"]);
    expect(none.reportAgeMs).toBeNull();
  });

  it("a report past the max age degrades to source stale, items carried with their age", () => {
    const reportedAt = new Date("2026-09-03T04:00:00Z");
    const fresh = { ...report, gcloud: { installed: true, account: "op@sarala.ai", live: true } };
    const justInside = reportedAt.getTime() + WORKSTATION_REPORT_MAX_AGE_MS;
    expect(operatorAuthFromWorkstationReport({ report: fresh, reportedAt }, justInside).source).toBe("workstation");
    const past = justInside + 1;
    const stale = operatorAuthFromWorkstationReport({ report: fresh, reportedAt }, past);
    expect(stale.source).toBe("stale");
    expect(stale.gcloud).toBe("ok");
    expect(stale.reportAgeMs).toBe(WORKSTATION_REPORT_MAX_AGE_MS + 1);
    expect(summarizeWorkstationReport({ report: fresh, reportedAt }, past)).toEqual({
      reportedAt: "2026-09-03T04:00:00.000Z",
      stale: true,
      gcloud: { account: "op@sarala.ai", live: true },
      gh: { user: "operator" },
    });
    expect(summarizeWorkstationReport(null)).toBeNull();
  });

  it("only a local-trusted instance is the operator's own machine", () => {
    expect(serverIsOperatorWorkstation({})).toBe(true);
    expect(serverIsOperatorWorkstation({ PAPERCLIP_DEPLOYMENT_MODE: "local_trusted" })).toBe(true);
    expect(serverIsOperatorWorkstation({ PAPERCLIP_DEPLOYMENT_MODE: "authenticated" })).toBe(false);
  });
});
