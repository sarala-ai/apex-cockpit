import { describe, expect, it } from "vitest";
import {
  GOAL_ASSUMPTION_STATUSES,
  GOAL_ASSUMPTION_TYPES,
  GOAL_CLOSURES,
  GOAL_LEVELS,
  GOAL_STATUSES,
} from "../constants.js";
import {
  createGoalSchema,
  updateGoalSchema,
  goalAssumptionSchema,
  initiativeFieldsRejectedFor,
} from "./goal.js";

const assumption = {
  id: "a1",
  statement: "Extraction is accurate enough on real documents",
  type: "technical" as const,
  status: "untested" as const,
};

describe("goal level vocabulary", () => {
  it("carries the initiative level alongside the levels that already existed", () => {
    expect(GOAL_LEVELS).toContain("initiative");
    // The pre-existing levels keep their meaning and their membership.
    for (const level of ["company", "team", "agent", "task"]) {
      expect(GOAL_LEVELS).toContain(level);
    }
  });

  it("leaves GOAL_STATUSES untouched — closures are a separate vocabulary", () => {
    expect([...GOAL_STATUSES]).toEqual(["planned", "active", "achieved", "cancelled"]);
    for (const closure of GOAL_CLOSURES) {
      expect(GOAL_STATUSES).not.toContain(closure);
    }
  });

  it("names the four initiative closures the model defines", () => {
    expect([...GOAL_CLOSURES]).toEqual(["validated", "stopped", "revised", "expired"]);
  });

  it("types assumptions by discipline and by where they stand", () => {
    expect([...GOAL_ASSUMPTION_TYPES]).toEqual([
      "technical",
      "regulatory",
      "commercial",
      "operational",
    ]);
    expect([...GOAL_ASSUMPTION_STATUSES]).toEqual(["untested", "retired", "blocked"]);
  });
});

describe("createGoalSchema", () => {
  it("accepts a full initiative", () => {
    const parsed = createGoalSchema.parse({
      title: "Proactive alerts",
      level: "initiative",
      hypothesis: "Households act on proactive alerts",
      budget: "two weeks",
      stopCondition: "extraction error over 10%",
      assumptions: [assumption, { ...assumption, id: "a2", type: "regulatory", status: "blocked", evidence: "consent covers on-request access only" }],
    });
    expect(parsed.level).toBe("initiative");
    expect(parsed.assumptions).toHaveLength(2);
    expect(parsed.assumptions?.[1]?.evidence).toBe("consent covers on-request access only");
  });

  it("accepts a bare initiative — no hypothesis, no assumptions", () => {
    const parsed = createGoalSchema.parse({ title: "Ship the importer", level: "initiative" });
    expect(parsed.hypothesis).toBeUndefined();
    expect(parsed.assumptions).toBeUndefined();
  });

  it.each(GOAL_CLOSURES)("closes an initiative as %s", (closure) => {
    const parsed = createGoalSchema.parse({
      title: "Proactive alerts",
      level: "initiative",
      closure,
      closureReason: "second-alert engagement 22%, under the 30% line",
    });
    expect(parsed.closure).toBe(closure);
  });

  it("still defaults an ordinary goal to a task with no initiative fields", () => {
    const parsed = createGoalSchema.parse({ title: "Plain goal" });
    expect(parsed.level).toBe("task");
    expect(parsed.status).toBe("planned");
    expect(parsed.closure).toBeUndefined();
  });

  it.each(["company", "team", "agent", "task"])(
    "rejects initiative-only fields on a %s goal",
    (level) => {
      const result = createGoalSchema.safeParse({
        title: "Not an initiative",
        level,
        stopCondition: "a commitment nobody made",
      });
      expect(result.success).toBe(false);
    },
  );

  it("rejects a closure on a non-initiative goal", () => {
    expect(
      createGoalSchema.safeParse({ title: "Team goal", level: "team", closure: "validated" }).success,
    ).toBe(false);
  });

  it("leaves the other levels' own statuses alone", () => {
    for (const level of ["company", "team", "agent", "task"]) {
      for (const status of GOAL_STATUSES) {
        expect(createGoalSchema.safeParse({ title: "t", level, status }).success).toBe(true);
      }
    }
  });

  it("rejects an unknown closure or assumption status", () => {
    expect(
      createGoalSchema.safeParse({ title: "t", level: "initiative", closure: "shipped" }).success,
    ).toBe(false);
    expect(
      goalAssumptionSchema.safeParse({ ...assumption, status: "maybe" }).success,
    ).toBe(false);
  });
});

describe("updateGoalSchema", () => {
  it("accepts a closure on its own", () => {
    const parsed = updateGoalSchema.parse({ closure: "stopped", closureReason: "budget spent" });
    expect(parsed.closure).toBe("stopped");
  });

  it("accepts clearing the initiative fields with null", () => {
    const parsed = updateGoalSchema.parse({ hypothesis: null, assumptions: null });
    expect(parsed.hypothesis).toBeNull();
  });
});

describe("initiativeFieldsRejectedFor", () => {
  it("passes anything through for an initiative", () => {
    expect(initiativeFieldsRejectedFor("initiative", { budget: "2w", closure: "validated" })).toEqual(
      [],
    );
  });

  it("names the offending fields for any other level", () => {
    expect(initiativeFieldsRejectedFor("task", { budget: "2w", closure: "validated" })).toEqual([
      "closure",
      "budget",
    ]);
  });

  it("ignores absent and null fields — clearing is not setting", () => {
    expect(initiativeFieldsRejectedFor("team", { title: "x", hypothesis: null })).toEqual([]);
  });
});
