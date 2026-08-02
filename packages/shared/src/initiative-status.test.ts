import { describe, expect, it } from "vitest";
import { INITIATIVE_DERIVED_STATUSES, PROJECT_STATUSES } from "./constants.js";
import { deriveInitiativeStatus, summarizeInitiativeProjects } from "./initiative-status.js";

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
      "built",
      "completed",
      "folded",
      "cancelled",
    ]);
  });

  it("can express built-but-never-exercised, distinctly from completed", () => {
    // Four real projects sat in `in_progress` for months because `completed`
    // would have claimed an exercise nobody had performed.
    expect(PROJECT_STATUSES).toContain("built");
    expect(PROJECT_STATUSES).toContain("completed");
  });

  it("can express folded, the closure the model doc always listed", () => {
    expect(PROJECT_STATUSES).toContain("folded");
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

  it("reports delivered only when every live project is built or completed", () => {
    expect(deriveInitiativeStatus(["completed", "completed"])).toBe("delivered");
    expect(deriveInitiativeStatus(["completed", "built"])).toBe("delivered");
    expect(deriveInitiativeStatus(["completed", "backlog"])).toBe("active");
  });

  it("reports partial, not delivered, when a cancelled project is behind it", () => {
    // This used to read "delivered": cancelled projects dropped out of the live
    // set and took the failure with them.
    expect(deriveInitiativeStatus(["completed", "cancelled"])).toBe("partial");
    expect(deriveInitiativeStatus(["built", "cancelled"])).toBe("partial");
    expect(deriveInitiativeStatus(["completed", "cancelled", "cancelled"])).toBe("partial");
  });

  it("MCP-first regression: an initiative whose own sentence was falsified is not delivered", () => {
    // "Every interface generated from MCP tools" — one project shipped, two
    // failed and were cancelled. The derivation reported `delivered`, and the
    // importer had to work around it by closing the initiative as `revised`.
    // The reading must carry the failure, not hide it.
    const mcpFirst = ["completed", "cancelled", "cancelled"];
    expect(deriveInitiativeStatus(mcpFirst)).toBe("partial");
    expect(deriveInitiativeStatus(mcpFirst)).not.toBe("delivered");
    expect(summarizeInitiativeProjects(mcpFirst).cancelled).toBe(2);
  });

  it("a fold does not make the reading partial — the outcome moved, it was not abandoned", () => {
    expect(deriveInitiativeStatus(["completed", "folded"])).toBe("delivered");
    // …but a cancellation alongside it still does.
    expect(deriveInitiativeStatus(["completed", "folded", "cancelled"])).toBe("partial");
  });

  it("counts built projects toward delivery, and reports how many were never exercised", () => {
    // Initiative `delivered` has always meant "the projects are done", never
    // "this was worth doing" — that is `closure: validated`. The count is what
    // keeps it honest.
    expect(deriveInitiativeStatus(["built", "built"])).toBe("delivered");
    expect(summarizeInitiativeProjects(["built", "built", "completed"]).built).toBe(2);
    expect(deriveInitiativeStatus(["built", "backlog"])).toBe("active");
  });

  it("reports cancelled when nothing live is left", () => {
    expect(deriveInitiativeStatus(["cancelled", "cancelled"])).toBe("cancelled");
    expect(deriveInitiativeStatus(["cancelled", "folded"])).toBe("cancelled");
    expect(deriveInitiativeStatus(["cancelled", "on_hold"])).toBe("on_hold");
  });

  it("an asserted hold overrides whatever the projects say", () => {
    // "Zero-token agents" and "A new project starts from a template" both read
    // `active` — two of each one's projects had completed — when the honest
    // reading was: valid, not now. No arrangement of child rows can say that.
    expect(deriveInitiativeStatus(["completed", "completed"], { held: true })).toBe("on_hold");
    expect(deriveInitiativeStatus(["in_progress"], { held: true })).toBe("on_hold");
    expect(deriveInitiativeStatus([], { held: true })).toBe("on_hold");
    expect(deriveInitiativeStatus(["completed", "cancelled"], { held: true })).toBe("on_hold");
  });

  it("leaves the derived reading alone when no hold was asserted", () => {
    expect(deriveInitiativeStatus(["in_progress"], { held: false })).toBe("active");
    expect(deriveInitiativeStatus(["in_progress"], {})).toBe("active");
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
      ["built"],
      ["folded"],
      ["cancelled"],
      ["completed", "on_hold", "backlog", "cancelled"],
      ["built", "folded", "cancelled"],
    ];
    for (const input of inputs) {
      expect(INITIATIVE_DERIVED_STATUSES).toContain(deriveInitiativeStatus(input));
      expect(INITIATIVE_DERIVED_STATUSES).toContain(
        deriveInitiativeStatus(input, { held: true }),
      );
    }
  });
});

describe("summarizeInitiativeProjects", () => {
  it("counts every status apart, so no closure can hide inside another", () => {
    const counts = summarizeInitiativeProjects([
      "backlog",
      "planned",
      "in_progress",
      "on_hold",
      "built",
      "completed",
      "folded",
      "cancelled",
    ]);
    expect(counts).toEqual({
      total: 8,
      live: 6,
      completed: 1,
      built: 1,
      inProgress: 1,
      onHold: 1,
      notStarted: 2,
      cancelled: 1,
      folded: 1,
    });
  });

  it("is all zeroes for an initiative with nothing decomposed yet", () => {
    expect(summarizeInitiativeProjects([])).toEqual({
      total: 0,
      live: 0,
      completed: 0,
      built: 0,
      inProgress: 0,
      onHold: 0,
      notStarted: 0,
      cancelled: 0,
      folded: 0,
    });
  });
});
