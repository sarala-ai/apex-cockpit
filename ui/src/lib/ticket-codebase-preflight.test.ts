import { describe, expect, it } from "vitest";
import {
  defaultCodebaseProjectId,
  evaluateCodebasePreflight,
  isExecutableIssueStatus,
  projectsWithRepository,
  type TicketTypeOption,
} from "./ticket-codebase-preflight";

const BOUNDED_GRANT = "Read Edit Write Bash Glob Grep";
const READ_ONLY_GRANT = "AskUserQuestion Glob Grep Monitor Read TaskOutput TaskStop ToolSearch";

const implementer = {
  name: "Implementer",
  adapterType: "claude_local",
  adapterConfig: { dangerouslySkipPermissions: false, allowedTools: BOUNDED_GRANT },
};
const specifier = {
  name: "Specifier",
  adapterType: "claude_local",
  adapterConfig: { dangerouslySkipPermissions: false, allowedTools: READ_ONLY_GRANT },
};

const bugType: TicketTypeOption = {
  ticketType: "bug",
  pipelineId: "pipeline-bug",
  pipelineKey: "bug",
  pipelineName: "Bug",
  processlessByDesign: false,
  commissionsRepoWritingAgent: true,
};
const choreType: TicketTypeOption = {
  ticketType: "chore",
  pipelineId: null,
  pipelineKey: null,
  pipelineName: null,
  processlessByDesign: true,
  commissionsRepoWritingAgent: false,
};

const boundProject = { id: "p1", name: "APEX Cockpit", repoUrl: "sarala-ai/apex-cockpit" };
const unboundProject = { id: "p2", name: "Notes", repoUrl: null };

function evaluate(overrides: Partial<Parameters<typeof evaluateCodebasePreflight>[0]> = {}) {
  return evaluateCodebasePreflight({
    status: "todo",
    assignee: null,
    ticketTypeOption: null,
    selectedProject: null,
    selectedProjectWasDefaulted: false,
    ...overrides,
  });
}

describe("the trigger is the commission, not the empty field", () => {
  it("says nothing about a ticket with no assignee and no type", () => {
    expect(evaluate().kind).toBe("not_needed");
  });

  it("says nothing about a chore with no project — a chore commissions nobody", () => {
    expect(evaluate({ ticketTypeOption: choreType }).kind).toBe("not_needed");
  });

  it("says nothing about a read-only assignee with no project", () => {
    // The Specifier is deliberately unable to write a repo. Demanding one from
    // it would be a nag on a ticket that will never need a checkout.
    expect(evaluate({ assignee: specifier }).kind).toBe("not_needed");
  });

  it("fires on a repo-writing assignee with no project", () => {
    const result = evaluate({ assignee: implementer });
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.demandedBy).toBe("assignee");
    expect(result.message).toContain("Implementer");
    expect(result.message).toContain("Pick a project with a repository");
  });

  it("fires on a lifecycle that commissions a repo writer even with no assignee", () => {
    const result = evaluate({ ticketTypeOption: bugType });
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.demandedBy).toBe("lifecycle");
    expect(result.message).toContain("Bug process");
  });

  it("does not fire when a project row exists but carries no repository", () => {
    // A project is not a codebase. This is exactly the confusion the dispatch
    // precondition had to be taught and it is not repeated here.
    const result = evaluate({ assignee: implementer, selectedProject: unboundProject });
    expect(result.kind).toBe("missing");
  });
});

describe("status decides block versus warn", () => {
  it("blocks an executable ticket", () => {
    for (const status of ["todo", "in_progress"]) {
      const result = evaluate({ status, assignee: implementer });
      expect(result.kind === "missing" && result.blocking).toBe(true);
    }
  });

  it("only warns on a ticket parked in backlog", () => {
    const result = evaluate({ status: "backlog", assignee: implementer });
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") return;
    expect(result.blocking).toBe(false);
    expect(result.message).toContain("parked in Backlog");
  });

  it("agrees with isExecutableIssueStatus", () => {
    expect(isExecutableIssueStatus("todo")).toBe(true);
    expect(isExecutableIssueStatus("in_progress")).toBe(true);
    expect(isExecutableIssueStatus("backlog")).toBe(false);
    expect(isExecutableIssueStatus("done")).toBe(false);
  });
});

describe("a bound repository satisfies the demand", () => {
  it("reports satisfied and names the repo", () => {
    const result = evaluate({ assignee: implementer, selectedProject: boundProject });
    expect(result.kind).toBe("satisfied");
    if (result.kind !== "satisfied") return;
    expect(result.repoUrl).toBe("sarala-ai/apex-cockpit");
    expect(result.defaulted).toBe(false);
    expect(result.message).toContain("APEX Cockpit");
  });

  it("says so when the composer defaulted, not the author", () => {
    const result = evaluate({
      assignee: implementer,
      selectedProject: boundProject,
      selectedProjectWasDefaulted: true,
    });
    expect(result.kind).toBe("satisfied");
    if (result.kind !== "satisfied") return;
    expect(result.defaulted).toBe(true);
    expect(result.message).toContain("the only project with a repository bound");
    expect(result.message).toContain("Change it above");
  });
});

describe("the default is offered only when there is nothing to get wrong", () => {
  it("defaults to the single repo-bound project", () => {
    expect(defaultCodebaseProjectId([boundProject, unboundProject])).toBe("p1");
  });

  it("refuses to guess between two repo-bound projects", () => {
    expect(
      defaultCodebaseProjectId([boundProject, { id: "p3", name: "Bloom", repoUrl: "sarala-ai/bloom" }]),
    ).toBeNull();
  });

  it("has nothing to offer when no project has a repository", () => {
    expect(defaultCodebaseProjectId([unboundProject])).toBeNull();
    expect(projectsWithRepository([unboundProject])).toEqual([]);
  });

  it("treats a whitespace-only repo url as no repository", () => {
    expect(projectsWithRepository([{ id: "p4", name: "Blank", repoUrl: "   " }])).toEqual([]);
  });
});
