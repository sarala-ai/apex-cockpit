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

describe("InitiativeSummary — validation criteria", () => {
  const criterion = (overrides: Record<string, unknown> = {}) =>
    ({
      id: "c1",
      statement: "Agents reach for tools rather than freelancing",
      measure: "tool calls / total assistant turns",
      threshold: "≥80%",
      window: "first four weeks",
      ownerUserId: "srinivas",
      // Far future: pending but not yet due, unless a test says otherwise.
      reviewDate: "2099-01-01",
      status: "pending",
      ...overrides,
    }) as never;

  it("renders a pending criterion with its threshold, reader and review date", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary goal={goal({ validationCriteria: [criterion()] })} />,
    );
    expect(html).toContain("Validation criteria (1)");
    expect(html).toContain("Agents reach for tools rather than freelancing");
    expect(html).toContain("≥80%");
    expect(html).toContain("srinivas");
    expect(html).toContain("1 Jan 2099");
    expect(html).toContain("pending");
    expect(html).not.toContain("Due for review");
  });

  it("makes an overdue criterion impossible to miss", () => {
    // The unread criterion is the failure this whole object exists to prevent;
    // a quiet grey row is how it goes unread again.
    const html = renderToStaticMarkup(
      <InitiativeSummary goal={goal({ validationCriteria: [criterion({ reviewDate: "2020-01-01" })] })} />,
    );
    expect(html).toContain("Due for review");
    expect(html).toContain("text-destructive");
    expect(html).toContain("bg-destructive/10");
  });

  it("flags a criterion due today, not only one already past", () => {
    const today = new Date().toISOString().slice(0, 10);
    const html = renderToStaticMarkup(
      <InitiativeSummary goal={goal({ validationCriteria: [criterion({ reviewDate: today })] })} />,
    );
    expect(html).toContain("Due for review");
  });

  it("renders a reported criterion with its verdict and note, and no overdue styling", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({
          validationCriteria: [
            criterion({
              reviewDate: "2020-01-01",
              status: "hit",
              reviewedAt: "2020-01-02T00:00:00Z",
              reviewNote: "84% over 1,412 turns",
            }),
            criterion({ id: "c2", reviewDate: "2020-01-01", status: "missed", statement: "Second bar" }),
          ],
        })}
      />,
    );
    expect(html).toContain("hit");
    expect(html).toContain("missed");
    expect(html).toContain("84% over 1,412 turns");
    expect(html).not.toContain("Due for review");
  });

  it("renders never_registered as the honest record it is, never as overdue", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({
          validationCriteria: [
            {
              id: "c1",
              statement: "No validation criteria were registered for this initiative",
              status: "never_registered",
            } as never,
          ],
        })}
      />,
    );
    expect(html).toContain("never registered");
    expect(html).toContain("no reader");
    expect(html).not.toContain("Due for review");
  });

  it("renders provenance so an agent citing this later can weight it", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({ provenance: { kind: "inferred", source: "47 commits, March to May" } })}
      />,
    );
    expect(html).toContain("Provenance");
    expect(html).toContain("inferred");
    expect(html).toContain("47 commits, March to May");
  });

  it("renders NOTHING for an initiative with no criteria and nothing else written down", () => {
    // Empty chrome reads as "we wrote this down and it was empty"; the truth is
    // nobody wrote it down at all.
    expect(renderToStaticMarkup(<InitiativeSummary goal={goal({ validationCriteria: [] })} />)).toBe("");
    expect(renderToStaticMarkup(<InitiativeSummary goal={goal({ validationCriteria: null })} />)).toBe("");
  });
});

/** Just enough of a Project for the summary — it reads status, id and name. */
function project(overrides: Record<string, unknown> = {}) {
  return {
    id: "project-1",
    name: "MCP server layer",
    status: "completed",
    ...overrides,
  } as never;
}

describe("InitiativeSummary — the hold", () => {
  it("shows the hold, its reason, and that it overrides the projects", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({
          hold: {
            reason: "waiting on a local model worth running",
            since: "2026-07-02",
            byUserId: "srinivas",
            reviewDate: "2026-10-01",
          },
        })}
      />,
    );
    expect(html).toContain("Held");
    expect(html).toContain("overrides");
    expect(html).toContain("waiting on a local model worth running");
    expect(html).toContain("2 Jul 2026");
    expect(html).toContain("srinivas");
    expect(html).toContain("1 Oct 2026");
  });

  it("renders nothing when no hold was asserted", () => {
    expect(renderToStaticMarkup(<InitiativeSummary goal={goal()} />)).toBe("");
    expect(renderToStaticMarkup(<InitiativeSummary goal={goal({ hold: null })} />)).toBe("");
  });
});

describe("InitiativeSummary — hypotheses", () => {
  it("renders each hypothesis with its verdict, evidence and date", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({
          hypotheses: [
            {
              id: "h1",
              statement: "An MCP-only interface is enough",
              verdict: "falsified",
              evidence: "two of three projects cancelled",
              testedAt: "2026-05-30",
            },
            {
              id: "h2",
              statement: "Local models are cheap enough",
              verdict: "untested",
            },
          ],
        } as never)}
      />,
    );
    expect(html).toContain("Hypotheses (2)");
    expect(html).toContain("An MCP-only interface is enough");
    expect(html).toContain("falsified");
    expect(html).toContain("two of three projects cancelled");
    expect(html).toContain("30 May 2026");
    expect(html).toContain("untested");
  });

  it("keeps the original prose readable, and labels it as the original", () => {
    // It is not migratable: three of the ten populated fields hold two or three
    // questions in one string with their verdicts written as prose.
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({
          hypothesis: "MCP-only is enough; and local models are cheap enough",
          hypotheses: [{ id: "h1", statement: "An MCP-only interface is enough", verdict: "untested" }],
        } as never)}
      />,
    );
    expect(html).toContain("Hypothesis (as originally written)");
    expect(html).toContain("MCP-only is enough; and local models are cheap enough");
  });

  it("still says plain Hypothesis when there is only the prose", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary goal={goal({ hypothesis: "Households act on alerts" })} />,
    );
    expect(html).toContain("Hypothesis</h3>");
    expect(html).not.toContain("as originally written");
  });

  it("renders nothing for an initiative with an empty hypothesis list", () => {
    expect(renderToStaticMarkup(<InitiativeSummary goal={goal({ hypotheses: [] } as never)} />)).toBe("");
  });
});

describe("InitiativeSummary — the project reading", () => {
  it("shows the cancelled count, so delivered cannot imply completeness it lacks", () => {
    // The MCP-first case: one project shipped, two failed. The board must not
    // be able to report completeness for a sentence that was falsified.
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal({
          derivedStatus: "partial",
          projectCounts: {
            total: 3,
            live: 1,
            completed: 1,
            built: 0,
            inProgress: 0,
            onHold: 0,
            notStarted: 0,
            cancelled: 2,
            folded: 0,
          },
        } as never)}
      />,
    );
    expect(html).toContain("Projects (3)");
    expect(html).toContain("2 cancelled");
    expect(html).toContain("1 completed");
  });

  it("shows built-not-exercised distinctly from completed", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal()}
        projects={[
          project({ id: "p1", status: "built", name: "apex-eval" }),
          project({ id: "p2", status: "built", name: "Observe pillar" }),
          project({ id: "p3", status: "completed", name: "Provenance" }),
        ]}
      />,
    );
    expect(html).toContain("2 built, not exercised");
    expect(html).toContain("1 completed");
  });

  it("names where each folded project went, and links it", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal()}
        projects={[project({ id: "p1", status: "folded", name: "Skill packs as the moat" })]}
        foldDestinations={{
          p1: { label: "Agents and infrastructure are one surface", href: "/goals/goal-9" },
        }}
      />,
    );
    expect(html).toContain("1 folded");
    expect(html).toContain("Skill packs as the moat folded into");
    expect(html).toContain("Agents and infrastructure are one surface");
    expect(html).toContain("/goals/goal-9");
  });

  it("says so in words when a fold has no destination recorded", () => {
    const html = renderToStaticMarkup(
      <InitiativeSummary
        goal={goal()}
        projects={[project({ id: "p1", status: "folded", name: "Skill packs as the moat" })]}
      />,
    );
    expect(html).toContain("an unrecorded destination");
  });

  it("renders no project block when there is nothing the status does not already say", () => {
    // Five healthy projects need no commentary; a count repeated under a
    // heading is the empty chrome this component refuses to draw.
    expect(
      renderToStaticMarkup(
        <InitiativeSummary
          goal={goal()}
          projects={[project({ status: "completed" }), project({ id: "p2", status: "in_progress" })]}
        />,
      ),
    ).toBe("");
  });
});
