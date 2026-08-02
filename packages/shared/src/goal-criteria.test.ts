import { describe, expect, it } from "vitest";
import { criterionReviewKey, isCriterionDue, needsSurfacing } from "./goal-criteria.js";

const NOW = new Date("2026-08-02T09:00:00Z");

const criterion = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "c1",
    statement: "x",
    ownerUserId: "srinivas",
    reviewDate: "2026-08-01",
    status: "pending",
    ...overrides,
  }) as never;

describe("isCriterionDue", () => {
  it("is true once the review date has passed", () => {
    expect(isCriterionDue(criterion(), NOW)).toBe(true);
  });

  it("is true on the day itself — the reader is prompted when they said, not the day after", () => {
    expect(isCriterionDue(criterion({ reviewDate: "2026-08-02" }), NOW)).toBe(true);
  });

  it("is false before the review date", () => {
    expect(isCriterionDue(criterion({ reviewDate: "2026-09-01" }), NOW)).toBe(false);
  });

  it("is false once a verdict exists — reported is not overdue", () => {
    expect(isCriterionDue(criterion({ status: "hit" }), NOW)).toBe(false);
    expect(isCriterionDue(criterion({ status: "missed" }), NOW)).toBe(false);
  });

  it("is false for never_registered, which has no date by construction", () => {
    expect(isCriterionDue(criterion({ status: "never_registered", reviewDate: null }), NOW)).toBe(
      false,
    );
  });

  it("is false for an unparseable date rather than treating it as due forever", () => {
    expect(isCriterionDue(criterion({ reviewDate: "soonish" }), NOW)).toBe(false);
  });
});

describe("needsSurfacing", () => {
  it("is true for a due criterion nobody has been told about", () => {
    expect(needsSurfacing(criterion(), NOW)).toBe(true);
  });

  it("is false once it has been surfaced — this is what makes the sweep idempotent", () => {
    expect(needsSurfacing(criterion({ surfacedAt: "2026-08-01T09:00:00Z" }), NOW)).toBe(false);
  });
});

describe("criterionReviewKey", () => {
  it("is stable per criterion", () => {
    expect(criterionReviewKey("g1", "c1")).toBe("criterion-review:g1:c1");
  });
});
