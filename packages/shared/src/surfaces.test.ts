import { describe, expect, it } from "vitest";
import { SURFACES, SURFACE_SECTIONS, getSurface, type OrgFacts } from "./surfaces.js";

const BASE_FACTS: OrgFacts = {
  asOf: "2026-01-01T00:00:00.000Z",
  hasRepoOrCloudBinding: false,
  runsStarted: 0,
  runsCompleted: 0,
  firstRunAt: null,
  liveRunCount: 0,
  openPrCount: 0,
  deploysLanded: 0,
  gatewayCallAudited: false,
  orgMemberCount: 0,
  companyMemberCount: 0,
  goalCount: 0,
  operatorAuthHealthy: false,
};

function facts(patch: Partial<OrgFacts>): OrgFacts {
  return { ...BASE_FACTS, ...patch };
}

describe("SURFACES registry", () => {
  it("has a unique key for every surface", () => {
    const keys = SURFACES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every surface's section is one of SURFACE_SECTIONS", () => {
    for (const s of SURFACES) {
      expect(SURFACE_SECTIONS).toContain(s.section);
    }
  });

  it("getSurface finds an existing key and misses an unknown one", () => {
    expect(getSurface("dashboard")?.key).toBe("dashboard");
    expect(getSurface("not-a-real-surface")).toBeUndefined();
  });

  it("chat is the only surface marked always", () => {
    const always = SURFACES.filter((s) => s.always).map((s) => s.key);
    expect(always).toEqual(["chat"]);
  });

  it("an always surface is due regardless of facts", () => {
    const chat = getSurface("chat")!;
    expect(chat.due(BASE_FACTS).due).toBe(true);
  });
});

// One row per (key, facts patch, expected due) matching each surface's due()
// condition — an executable version of the rule table, not a paraphrase of it.
const CASES: Array<{ key: string; notDue: Partial<OrgFacts>; due: Partial<OrgFacts> }> = [
  { key: "projects", notDue: {}, due: { hasRepoOrCloudBinding: true } },
  { key: "secrets", notDue: {}, due: { hasRepoOrCloudBinding: true } },
  { key: "environments", notDue: {}, due: { hasRepoOrCloudBinding: true } },
  { key: "tasks", notDue: {}, due: { runsStarted: 1 } },
  { key: "inbox", notDue: {}, due: { runsStarted: 1 } },
  { key: "artifacts", notDue: {}, due: { runsStarted: 1 } },
  { key: "routines", notDue: {}, due: { runsStarted: 1 } },
  { key: "cases", notDue: {}, due: { runsStarted: 1 } },
  { key: "activity", notDue: {}, due: { runsStarted: 1 } },
  { key: "timeline", notDue: { runsStarted: 1 }, due: { runsStarted: 2 } },
  { key: "workspaces", notDue: { runsStarted: 1 }, due: { runsStarted: 2 } },
  { key: "pipelines", notDue: {}, due: { openPrCount: 1 } },
  { key: "releases", notDue: {}, due: { openPrCount: 1 } },
  { key: "approvals", notDue: {}, due: { openPrCount: 1 } },
  { key: "observe", notDue: {}, due: { deploysLanded: 1 } },
  { key: "observe", notDue: {}, due: { gatewayCallAudited: true } },
  { key: "costs", notDue: {}, due: { deploysLanded: 1 } },
  { key: "costs", notDue: {}, due: { gatewayCallAudited: true } },
  { key: "gateway", notDue: {}, due: { deploysLanded: 1 } },
  { key: "gateway", notDue: {}, due: { gatewayCallAudited: true } },
  { key: "skills", notDue: { runsCompleted: 1 }, due: { runsCompleted: 2 } },
  { key: "prompts", notDue: { runsCompleted: 1 }, due: { runsCompleted: 2 } },
  { key: "workflows", notDue: { runsCompleted: 1 }, due: { runsCompleted: 2 } },
  { key: "teams", notDue: { runsCompleted: 1 }, due: { runsCompleted: 2 } },
];

describe("due() rules — stage 2/3/4/5 proposal table", () => {
  for (const c of CASES) {
    it(`${c.key} is not due until its condition, then due once it holds`, () => {
      const surface = getSurface(c.key);
      expect(surface, `surface "${c.key}" must be registered`).toBeDefined();
      expect(surface!.due(facts(c.notDue)).due).toBe(false);
      const verdict = surface!.due(facts(c.due));
      expect(verdict.due).toBe(true);
      expect(verdict.reason.length).toBeGreaterThan(0);
    });
  }
});

describe("stage-1 surfaces are due from day one", () => {
  for (const key of ["dashboard", "design", "goals", "proposals", "agents"]) {
    it(`${key} is due against the zero-facts snapshot`, () => {
      expect(getSurface(key)!.due(BASE_FACTS).due).toBe(true);
    });
  }
});

describe("settings", () => {
  it("is never due by rule, regardless of facts", () => {
    const settings = getSurface("settings")!;
    expect(settings.always).toBeFalsy();
    expect(settings.due(BASE_FACTS).due).toBe(false);
    expect(
      settings.due(
        facts({
          hasRepoOrCloudBinding: true,
          runsStarted: 10,
          runsCompleted: 10,
          openPrCount: 5,
          deploysLanded: 5,
          gatewayCallAudited: true,
        }),
      ).due,
    ).toBe(false);
  });
});
