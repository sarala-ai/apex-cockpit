import { describe, expect, it } from "vitest";
import { INITIATIVE_DERIVED_STATUSES, PROJECT_STATUSES } from "./constants.js";
import { deriveInitiativeStatus } from "./initiative-status.js";

describe("PROJECT_STATUSES", () => {
  it("can express valid-but-not-now", () => {
    expect(PROJECT_STATUSES).toContain("on_hold");
  });

  it("keeps backlog as not-started and leaves the existing statuses in place", () => {
    expect([...PROJECT_STATUSES]).toEqual([
      "backlog",
      "planned",
      "in_progress",
      "on_hold",
      "completed",
      "cancelled",
    ]);
  });
});

describe("deriveInitiativeStatus", () => {
  it("reads the founder's multi-cloud initiative as active, not expired", () => {
    // GCP delivered, AWS on hold, Azure not started, agnostic workflows not started.
    expect(deriveInitiativeStatus(["completed", "on_hold", "backlog", "backlog"])).toBe("active");
  });

  it("reports planned for an initiative with no projects — nothing decomposed yet", () => {
    expect(deriveInitiativeStatus([])).toBe("planned");
  });

  it("reports delivered only when every live project is completed", () => {
    expect(deriveInitiativeStatus(["completed", "completed"])).toBe("delivered");
    // A cancelled sibling does not stop the rest from being delivered.
    expect(deriveInitiativeStatus(["completed", "cancelled"])).toBe("delivered");
    expect(deriveInitiativeStatus(["completed", "backlog"])).toBe("active");
  });

  it("reports cancelled only when every project is cancelled", () => {
    expect(deriveInitiativeStatus(["cancelled", "cancelled"])).toBe("cancelled");
    expect(deriveInitiativeStatus(["cancelled", "on_hold"])).toBe("on_hold");
  });

  it("reports on_hold when everything live is held", () => {
    expect(deriveInitiativeStatus(["on_hold"])).toBe("on_hold");
    expect(deriveInitiativeStatus(["on_hold", "on_hold"])).toBe("on_hold");
  });

  it("reports active as soon as anything is in progress", () => {
    expect(deriveInitiativeStatus(["in_progress", "on_hold", "backlog"])).toBe("active");
  });

  it("reports planned when work is queued but none has started or been held", () => {
    expect(deriveInitiativeStatus(["backlog", "planned"])).toBe("planned");
  });

  it("moving one project changes the reading — this is why it is not stored", () => {
    const before = ["backlog", "backlog"];
    expect(deriveInitiativeStatus(before)).toBe("planned");
    expect(deriveInitiativeStatus(["in_progress", "backlog"])).toBe("active");
    expect(deriveInitiativeStatus(["on_hold", "on_hold"])).toBe("on_hold");
    expect(deriveInitiativeStatus(["completed", "completed"])).toBe("delivered");
  });

  it("only ever answers with a member of the declared vocabulary", () => {
    const inputs = [
      [],
      ["backlog"],
      ["planned", "on_hold"],
      ["in_progress"],
      ["completed"],
      ["cancelled"],
      ["completed", "on_hold", "backlog", "cancelled"],
    ];
    for (const input of inputs) {
      expect(INITIATIVE_DERIVED_STATUSES).toContain(deriveInitiativeStatus(input));
    }
  });
});
