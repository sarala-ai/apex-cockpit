import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { computeOrgFacts, type OrgFactsProbes } from "../services/org-facts.js";

const healthy: OrgFactsProbes = {
  hasRepoOrCloudBinding: async () => true,
  runs: async () => ({ started: 3, completed: 2, firstRunAt: "2026-01-01T00:00:00.000Z", live: 1 }),
  openPrCount: async () => 1,
  deploysLanded: async () => 1,
  gatewayCallAudited: async () => true,
  orgMemberCount: async () => 2,
  companyMemberCount: async () => 5,
  goalCount: async () => 4,
  operatorAuthHealthy: async () => true,
};

const FAKE_DB = {} as unknown as Db;

describe("computeOrgFacts", () => {
  it("flattens every probe into one snapshot", async () => {
    const facts = await computeOrgFacts(FAKE_DB, { orgId: "org-1", userId: "user-1" }, healthy);
    expect(facts).toMatchObject({
      hasRepoOrCloudBinding: true,
      runsStarted: 3,
      runsCompleted: 2,
      firstRunAt: "2026-01-01T00:00:00.000Z",
      liveRunCount: 1,
      openPrCount: 1,
      deploysLanded: 1,
      gatewayCallAudited: true,
      orgMemberCount: 2,
      companyMemberCount: 5,
      goalCount: 4,
      operatorAuthHealthy: true,
    });
    expect(typeof facts.asOf).toBe("string");
    expect(new Date(facts.asOf).toString()).not.toBe("Invalid Date");
  });

  it("is failure-isolated — a throwing probe degrades to its safe fallback, the rest stays real", async () => {
    const facts = await computeOrgFacts(FAKE_DB, { orgId: "org-1" }, {
      ...healthy,
      runs: async () => {
        throw new Error("db is down");
      },
      openPrCount: async () => {
        throw new Error("runs.json unreadable");
      },
    });
    expect(facts.runsStarted).toBe(0);
    expect(facts.runsCompleted).toBe(0);
    expect(facts.firstRunAt).toBeNull();
    expect(facts.liveRunCount).toBe(0);
    expect(facts.openPrCount).toBe(0);
    // Unaffected probes still report their real values.
    expect(facts.hasRepoOrCloudBinding).toBe(true);
    expect(facts.goalCount).toBe(4);
  });

  it("passes a null userId through to operatorAuthHealthy when none is given", async () => {
    let seen: string | null | undefined = "UNSET";
    await computeOrgFacts(FAKE_DB, { orgId: "org-1" }, {
      ...healthy,
      operatorAuthHealthy: async (userId) => {
        seen = userId;
        return false;
      },
    });
    expect(seen).toBeNull();
  });
});
