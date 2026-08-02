import { describe, expect, it } from "vitest";
import {
  GOAL_ASSUMPTION_STATUSES,
  GOAL_ASSUMPTION_TYPES,
  GOAL_CLOSURES,
  GOAL_CRITERION_STATUSES,
  GOAL_LEVELS,
  GOAL_STATUSES,
} from "../constants.js";
import {
  createGoalSchema,
  updateGoalSchema,
  goalAssumptionSchema,
  goalValidationCriterionSchema,
  goalProvenanceSchema,
  reportCriterionSchema,
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

// ── Validation criteria ────────────────────────────────────────────────────
// The object that exists because ~40 pre-registered criteria were never read
// back. Its entire value is in what it REFUSES to store.

describe("goalValidationCriterionSchema", () => {
  const criterion = (overrides: Record<string, unknown> = {}) => ({
    id: "c1",
    statement: "Agents reach for tools rather than freelancing",
    measure: "tool calls / total assistant turns",
    threshold: "≥80%",
    window: "first four weeks after release",
    ownerUserId: "srinivas",
    reviewDate: "2026-09-01",
    status: "pending",
    ...overrides,
  });

  it("round-trips a well-formed criterion", () => {
    const parsed = goalValidationCriterionSchema.parse(criterion());
    expect(parsed.threshold).toBe("≥80%");
    expect(parsed.reviewDate).toBe("2026-09-01");
  });

  it("accepts an agent as the named reader", () => {
    const parsed = goalValidationCriterionSchema.parse(
      criterion({ ownerUserId: null, ownerAgentId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }),
    );
    expect(parsed.ownerAgentId).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });

  it("REJECTS a criterion with no named reader", () => {
    // "A criterion without a named reader and a date is not a criterion. It is
    // a wish with a number in it." — initiative-discipline.md §3
    const result = goalValidationCriterionSchema.safeParse(
      criterion({ ownerUserId: null, ownerAgentId: null }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("named reader");
  });

  it("REJECTS a criterion with no reviewDate", () => {
    const result = goalValidationCriterionSchema.safeParse(criterion({ reviewDate: null }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("reviewDate");
  });

  it("rejects a reviewDate that is not a date", () => {
    const result = goalValidationCriterionSchema.safeParse(criterion({ reviewDate: "soonish" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(goalValidationCriterionSchema.safeParse(criterion({ status: "ok" })).success).toBe(false);
  });

  it("accepts every declared status", () => {
    for (const status of GOAL_CRITERION_STATUSES) {
      if (status === "never_registered") continue;
      expect(goalValidationCriterionSchema.safeParse(criterion({ status })).success).toBe(true);
    }
  });

  it("accepts a never_registered criterion with no reader and no date", () => {
    const parsed = goalValidationCriterionSchema.parse({
      id: "c1",
      statement: "No validation criteria were registered for this initiative",
      status: "never_registered",
    });
    expect(parsed.status).toBe("never_registered");
  });

  it("REFUSES to retro-fit a reader or a date onto never_registered", () => {
    // Nobody registered one; recording one now would be fabrication, which is
    // worse than no memory because nobody knows to doubt it.
    const withOwner = goalValidationCriterionSchema.safeParse({
      id: "c1",
      statement: "No criteria were registered",
      status: "never_registered",
      ownerUserId: "srinivas",
    });
    expect(withOwner.success).toBe(false);
    const withDate = goalValidationCriterionSchema.safeParse({
      id: "c1",
      statement: "No criteria were registered",
      status: "never_registered",
      reviewDate: "2026-09-01",
    });
    expect(withDate.success).toBe(false);
  });

  it("carries a verdict once one is reported", () => {
    const parsed = goalValidationCriterionSchema.parse(
      criterion({ status: "missed", reviewedAt: "2026-09-02T10:00:00Z", reviewNote: "61%" }),
    );
    expect(parsed.status).toBe("missed");
    expect(parsed.reviewNote).toBe("61%");
  });
});

describe("goalProvenanceSchema", () => {
  it("round-trips confirmed with a source", () => {
    const parsed = goalProvenanceSchema.parse({ kind: "confirmed", source: "design doc, May 2026" });
    expect(parsed).toEqual({ kind: "confirmed", source: "design doc, May 2026" });
  });

  it("round-trips inferred without one", () => {
    expect(goalProvenanceSchema.parse({ kind: "inferred" }).kind).toBe("inferred");
  });

  it("rejects an unlabelled provenance", () => {
    expect(goalProvenanceSchema.safeParse({ source: "somewhere" }).success).toBe(false);
    expect(goalProvenanceSchema.safeParse({ kind: "probably" }).success).toBe(false);
  });
});

describe("criteria and provenance are initiative-only", () => {
  const criterion = {
    id: "c1",
    statement: "x",
    ownerUserId: "srinivas",
    reviewDate: "2026-09-01",
    status: "pending" as const,
  };

  it("createGoalSchema accepts them on an initiative", () => {
    const parsed = createGoalSchema.parse({
      title: "Every interface generated from MCP tools",
      level: "initiative",
      validationCriteria: [criterion],
      provenance: { kind: "inferred", source: "47 commits, March–May" },
    });
    expect(parsed.validationCriteria).toHaveLength(1);
    expect(parsed.provenance?.kind).toBe("inferred");
  });

  it.each(["company", "team", "agent", "task"])("createGoalSchema rejects them on a %s goal", (level) => {
    const criteriaResult = createGoalSchema.safeParse({
      title: "x",
      level,
      validationCriteria: [criterion],
    });
    expect(criteriaResult.success).toBe(false);
    const provenanceResult = createGoalSchema.safeParse({
      title: "x",
      level,
      provenance: { kind: "confirmed" },
    });
    expect(provenanceResult.success).toBe(false);
  });

  it("initiativeFieldsRejectedFor names them on a PATCH to a non-initiative", () => {
    expect(
      initiativeFieldsRejectedFor("task", {
        validationCriteria: [criterion],
        provenance: { kind: "confirmed" },
      }),
    ).toEqual(["validationCriteria", "provenance"]);
  });

  it("validation still runs inside the array on an initiative", () => {
    const result = createGoalSchema.safeParse({
      title: "x",
      level: "initiative",
      validationCriteria: [{ ...criterion, ownerUserId: null }],
    });
    expect(result.success).toBe(false);
  });
});

describe("reportCriterionSchema", () => {
  it("accepts hit and missed", () => {
    expect(reportCriterionSchema.parse({ status: "hit" }).status).toBe("hit");
    expect(reportCriterionSchema.parse({ status: "missed", reviewNote: "61%" }).reviewNote).toBe("61%");
  });

  it("refuses to un-report a criterion back to pending", () => {
    // A report is a one-way statement about what was seen.
    expect(reportCriterionSchema.safeParse({ status: "pending" }).success).toBe(false);
    expect(reportCriterionSchema.safeParse({ status: "never_registered" }).success).toBe(false);
  });
});
