// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Goal } from "@paperclipai/shared";
import { InitiativeSummary } from "./InitiativeSummary";

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
    closure: null,
    closureReason: null,
    assumptions: null,
    budget: null,
    stopCondition: null,
    hypothesis: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

describe("InitiativeSummary", () => {
  it("renders a full initiative — hypothesis, budget, stop condition, typed assumptions", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({
          hypothesis: "Households act on proactive alerts",
          budget: "two weeks",
          stopCondition: "extraction error over 10%",
          assumptions: [
            {
              id: "a1",
              statement: "Extraction is accurate enough",
              type: "technical",
              status: "retired",
              evidence: "6.2% error over 214 documents",
            },
            {
              id: "a2",
              statement: "Shipped consent covers proactive contact",
              type: "regulatory",
              status: "blocked",
            },
          ],
        })}
      />,
    );

    expect(html).toContain("Hypothesis");
    expect(html).toContain("Households act on proactive alerts");
    expect(html).toContain("Budget");
    expect(html).toContain("two weeks");
    expect(html).toContain("Stop condition");
    expect(html).toContain("extraction error over 10%");
    expect(html).toContain("Assumptions (2)");
    expect(html).toContain("technical");
    expect(html).toContain("regulatory");
    expect(html).toContain("retired");
    expect(html).toContain("blocked");
    expect(html).toContain("6.2% error over 214 documents");
  });

  it("renders a bare initiative as nothing at all — no empty chrome", () => {
    const html = renderToStaticMarkup(<InitiativeSummary goal={goal()} />);
    expect(html).toBe("");
  });

  it("omits the hypothesis block when there is no genuine question to test", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary goal={goal({ budget: "two weeks" })} />,
    );
    expect(html).toContain("two weeks");
    expect(html).not.toContain("Hypothesis");
    expect(html).not.toContain("Assumptions");
    expect(html).not.toContain("Stop condition");
  });

  it("shows how a closed initiative ended, with its reason", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({
          closure: "stopped",
          closureReason: "second-alert engagement 22%, under the 30% line",
        })}
      />,
    );
    expect(html).toContain("Closed as");
    expect(html).toContain("stopped");
    expect(html).toContain("second-alert engagement 22%");
  });

  it("renders nothing for a goal that is not an initiative, even if fields leaked in", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary goal={goal({ level: "team", budget: "two weeks" })} />,
    );
    expect(html).toBe("");
  });
});
