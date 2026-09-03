import { describe, expect, it } from "vitest";
import {
  healthFromReport,
  operatorAuthFromWorkstationReport,
  serverIsOperatorWorkstation,
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
    const status = operatorAuthFromWorkstationReport({ report, reportedAt });
    expect(status.source).toBe("workstation");
    expect(status.reportedAt).toBe("2026-09-03T04:00:00.000Z");
    expect(status.google).toEqual({ authed: true, account: "op@sarala.ai", live: false });
    expect(status.github).toEqual({ authed: true, user: "operator", live: true });

    const none = operatorAuthFromWorkstationReport(null);
    expect(none.source).toBe("none");
    expect(none.reportedAt).toBeNull();
    expect([none.gcloud, none.gh, none.adc]).toEqual(["missing", "missing", "missing"]);
  });

  it("only a local-trusted instance is the operator's own machine", () => {
    expect(serverIsOperatorWorkstation({})).toBe(true);
    expect(serverIsOperatorWorkstation({ PAPERCLIP_DEPLOYMENT_MODE: "local_trusted" })).toBe(true);
    expect(serverIsOperatorWorkstation({ PAPERCLIP_DEPLOYMENT_MODE: "authenticated" })).toBe(false);
  });
});
