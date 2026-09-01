import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { runIntakeCheck } from "./issue-intake.js";

// Minimal DB mock: capture the builder chain and return canned rows.
function makeMockDb(rows: {
  issues?: Record<string, unknown>[];
  projects?: Record<string, unknown>[];
  goals?: Record<string, unknown>[];
  epicCandidates?: Record<string, unknown>[];
}) {
  let callIndex = 0;
  const queryResults = [
    rows.issues ?? [],    // findDuplicates
    rows.projects ?? [],  // project list
    rows.goals ?? [],     // goal list
    rows.epicCandidates ?? [], // findEpicCandidates
  ];

  const buildChain = (result: unknown[]) => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve(result),
        }),
        limit: () => Promise.resolve(result),
      }),
    }),
  });

  return {
    select: () => {
      const result = queryResults[callIndex++ % queryResults.length] ?? [];
      return buildChain(result as unknown[]);
    },
  } as unknown as Db;
}

describe("runIntakeCheck", () => {
  it("surfaces missing projectId and goalId when absent", async () => {
    const db = makeMockDb({ issues: [], projects: [], goals: [], epicCandidates: [] });
    const result = await runIntakeCheck(db, "company-1", "Fix the login button", {
      projectId: null,
      goalId: null,
    });
    expect(result.missing).toContain("projectId");
    expect(result.missing).toContain("goalId");
  });

  it("does not flag missing fields when both are provided", async () => {
    const db = makeMockDb({ issues: [], projects: [], goals: [], epicCandidates: [] });
    const result = await runIntakeCheck(db, "company-1", "Fix the login button", {
      projectId: "proj-uuid",
      goalId: "goal-uuid",
    });
    expect(result.missing).toHaveLength(0);
  });

  it("returns duplicate candidates that exceed the word-match threshold", async () => {
    const issueRows = [
      { id: "dup-1", identifier: "APEX-10", title: "Fix the login form button", status: "todo", projectId: null, matchCount: 3 },
      { id: "dup-2", identifier: "APEX-11", title: "Update login styles", status: "backlog", projectId: null, matchCount: 1 },
    ];
    const db = makeMockDb({ issues: issueRows, projects: [], goals: [], epicCandidates: [] });
    const result = await runIntakeCheck(db, "company-1", "Fix the login button", { projectId: "p", goalId: "g" });
    // matchCount >= 2 qualifies; matchCount = 1 does not
    const dupIds = result.duplicates.map((d) => d.id);
    expect(dupIds).toContain("dup-1");
    expect(dupIds).not.toContain("dup-2");
  });

  it("returns empty duplicates when no issues match", async () => {
    const db = makeMockDb({ issues: [], projects: [], goals: [], epicCandidates: [] });
    const result = await runIntakeCheck(db, "company-1", "Brand new unique idea", { projectId: "p", goalId: "g" });
    expect(result.duplicates).toHaveLength(0);
  });

  it("passes through project and goal lists for suggestions", async () => {
    const projectRows = [
      { id: "proj-1", name: "APEX Core", goalId: "goal-1" },
    ];
    const goalRows = [
      { id: "goal-1", title: "Ship APEX v1" },
    ];
    const db = makeMockDb({ issues: [], projects: projectRows, goals: goalRows, epicCandidates: [] });
    const result = await runIntakeCheck(db, "company-1", "Any title", { projectId: null, goalId: null });
    expect(result.projects).toEqual([{ id: "proj-1", name: "APEX Core", goalId: "goal-1" }]);
    expect(result.goals).toEqual([{ id: "goal-1", title: "Ship APEX v1" }]);
  });
});
