// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Goal } from "@paperclipai/shared";
import { GoalHierarchyList } from "./GoalHierarchyList";

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    companyId: "company-1",
    title: "Proactive alerts",
    description: null,
    level: "initiative",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("GoalHierarchyList", () => {
  it("shows how a closed initiative ended, beside its status", () => {
    const html = renderToStaticMarkup(
      <GoalHierarchyList goals={[goal({ status: "achieved", closure: "stopped" })]} />,
    );
    expect(html).toContain("initiative");
    expect(html).toContain("stopped");
    expect(html).toContain("achieved");
  });

  it("renders an open initiative with no closure chrome", () => {
    const html = renderToStaticMarkup(<GoalHierarchyList goals={[goal()]} />);
    expect(html).toContain("Proactive alerts");
    expect(html).not.toContain("stopped");
    expect(html).not.toContain("validated");
  });

  it("leaves goals at the other levels exactly as they were", () => {
    const html = renderToStaticMarkup(
      <GoalHierarchyList goals={[goal({ level: "team", status: "planned" })]} />,
    );
    expect(html).toContain("team");
    expect(html).toContain("planned");
  });
});

describe("GoalHierarchyList — derived initiative status", () => {
  it("shows the status read from the projects, not the inert stored column", () => {
    const html = renderToStaticMarkup(
      <GoalHierarchyList goals={[goal({ status: "planned", derivedStatus: "active" })]} />,
    );
    expect(html).toContain("active");
    expect(html).not.toContain("planned");
  });

  it("falls back to the stored status when the row was never decorated", () => {
    const html = renderToStaticMarkup(<GoalHierarchyList goals={[goal({ status: "planned" })]} />);
    expect(html).toContain("planned");
  });

  it("shows an on-hold initiative as held, and its closure separately", () => {
    const html = renderToStaticMarkup(
      <GoalHierarchyList
        goals={[goal({ status: "active", derivedStatus: "on_hold", closure: "revised" })]}
      />,
    );
    expect(html).toContain("on hold");
    expect(html).toContain("revised");
  });

  it("never derives a status for the other levels", () => {
    const html = renderToStaticMarkup(
      <GoalHierarchyList goals={[goal({ level: "team", status: "active", derivedStatus: null })]} />,
    );
    expect(html).toContain("active");
  });
});
