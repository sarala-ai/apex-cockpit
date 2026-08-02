import { describe, expect, it } from "vitest";
import { createProjectSchema, foldLinkIssues, updateProjectSchema } from "./project.js";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const GOAL_ID = "22222222-2222-4222-8222-222222222222";

describe("fold links", () => {
  it("accepts a project folded into another project", () => {
    const parsed = createProjectSchema.parse({
      name: "Skill packs as the moat",
      status: "folded",
      foldedIntoProjectId: PROJECT_ID,
    });
    expect(parsed.status).toBe("folded");
    expect(parsed.foldedIntoProjectId).toBe(PROJECT_ID);
  });

  it("accepts a project folded into an initiative", () => {
    // "Skill packs as the moat" folded into another initiative, and had to be
    // recorded as `cancelled` with prose saying it had not been abandoned.
    const parsed = createProjectSchema.parse({
      name: "Skill packs as the moat",
      status: "folded",
      foldedIntoGoalId: GOAL_ID,
    });
    expect(parsed.foldedIntoGoalId).toBe(GOAL_ID);
  });

  it("accepts a fold whose destination is not on the board yet", () => {
    // Refusing it would push the row back to `cancelled`, which is the
    // misstatement these columns exist to remove.
    expect(createProjectSchema.safeParse({ name: "x", status: "folded" }).success).toBe(true);
    expect(foldLinkIssues("folded", {})).toEqual([]);
  });

  it("refuses two destinations — a project folds into one place", () => {
    expect(
      createProjectSchema.safeParse({
        name: "x",
        status: "folded",
        foldedIntoProjectId: PROJECT_ID,
        foldedIntoGoalId: GOAL_ID,
      }).success,
    ).toBe(false);
    expect(
      foldLinkIssues("folded", { foldedIntoProjectId: PROJECT_ID, foldedIntoGoalId: GOAL_ID }),
    ).toHaveLength(1);
  });

  it("refuses a fold link on a project that did not fold", () => {
    for (const status of ["backlog", "in_progress", "built", "completed", "cancelled"]) {
      expect(
        createProjectSchema.safeParse({ name: "x", status, foldedIntoGoalId: GOAL_ID }).success,
      ).toBe(false);
      expect(foldLinkIssues(status, { foldedIntoGoalId: GOAL_ID })).toHaveLength(1);
    }
  });

  it("refuses a project folding into itself", () => {
    expect(foldLinkIssues("folded", { foldedIntoProjectId: PROJECT_ID }, PROJECT_ID)).toEqual([
      "a project cannot fold into itself",
    ]);
    expect(foldLinkIssues("folded", { foldedIntoProjectId: PROJECT_ID }, GOAL_ID)).toEqual([]);
  });

  it("carries the links through a PATCH, and lets them be cleared", () => {
    expect(updateProjectSchema.parse({ foldedIntoGoalId: GOAL_ID }).foldedIntoGoalId).toBe(GOAL_ID);
    expect(updateProjectSchema.parse({ foldedIntoGoalId: null }).foldedIntoGoalId).toBeNull();
  });

  it("is silent about a normal project with no fold at all", () => {
    expect(foldLinkIssues("in_progress", {})).toEqual([]);
    expect(foldLinkIssues(undefined, {})).toEqual([]);
  });
});
