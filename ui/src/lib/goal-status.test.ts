import { describe, expect, it } from "vitest";
import {
  GOAL_CLOSURES,
  GOAL_ASSUMPTION_STATUSES,
  INITIATIVE_DERIVED_STATUSES,
  PROJECT_STATUSES,
} from "@paperclipai/shared";
import { statusBadge } from "./status-colors";
import { goalDisplayStatus, isDerivedGoalStatus } from "./goal-status";

describe("goalDisplayStatus", () => {
  it("prefers the derived reading for an initiative", () => {
    expect(
      goalDisplayStatus({ level: "initiative", status: "planned", derivedStatus: "active" }),
    ).toBe("active");
    expect(isDerivedGoalStatus({ level: "initiative", derivedStatus: "active" })).toBe(true);
  });

  it("falls back to the stored status when nothing was derived", () => {
    expect(goalDisplayStatus({ level: "initiative", status: "planned" })).toBe("planned");
    expect(isDerivedGoalStatus({ level: "initiative", derivedStatus: null })).toBe(false);
  });

  it("never substitutes anything for the other levels", () => {
    for (const level of ["company", "team", "agent", "task"] as const) {
      expect(goalDisplayStatus({ level, status: "active", derivedStatus: "delivered" })).toBe(
        "active",
      );
      expect(isDerivedGoalStatus({ level, derivedStatus: "delivered" })).toBe(false);
    }
  });
});

describe("status colours cover every new value", () => {
  // A missing entry does not throw — it silently renders as muted grey, which
  // is how a new status quietly loses its meaning in the UI.
  it.each([
    ...PROJECT_STATUSES,
    ...INITIATIVE_DERIVED_STATUSES,
    ...GOAL_CLOSURES,
    ...GOAL_ASSUMPTION_STATUSES,
  ])("has a colour for %s", (status) => {
    expect(statusBadge[status], `no statusBadge entry for "${status}"`).toBeDefined();
  });
});
