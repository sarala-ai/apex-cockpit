/**
 * The ticket-readability split, from both ends:
 *
 * - the human body stays the human body, and the machine brief lives in its
 *   own field — but the agent must still receive the brief IN FULL, through
 *   exactly the channel the description always used;
 * - a bounded agent step is told, in production, how to report: one sentence
 *   of outcome, then only what a reader could not already see.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_STEP_REPORT_INSTRUCTION,
  buildAgentInstructionComment,
  renderAgentPrompt,
} from "../apex/steps/agent-step.js";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";

const HUMAN_BODY = "Record the first governed design-change loop on the Flows & gates board.";
const AGENT_BRIEF = [
  "File id: 7adae259-016c-80f6-8008-63c0df3fac5a",
  '{"type": "add-obj", "x": 5190, "y": 952, "fontSize": 12}',
  "apex run penpot update-file --output json",
].join("\n");

function taskMarkdown(overrides: { description?: string | null; agentBrief?: string | null } = {}) {
  return buildPaperclipTaskMarkdown({
    issue: {
      id: "11111111-1111-1111-1111-111111111111",
      identifier: "APE-5",
      title: "Board note: record the first governed design-change loop",
      workMode: "standard",
      description: overrides.description === undefined ? HUMAN_BODY : overrides.description,
      agentBrief: overrides.agentBrief === undefined ? AGENT_BRIEF : overrides.agentBrief,
    },
  });
}

describe("the agent brief still reaches the agent in full", () => {
  it("delivers the brief in the task context, verbatim, alongside the human body", () => {
    const markdown = taskMarkdown() ?? "";
    expect(markdown).toContain("Issue description:");
    expect(markdown).toContain(HUMAN_BODY);
    expect(markdown).toContain("Agent brief");
    for (const line of AGENT_BRIEF.split("\n")) {
      expect(markdown).toContain(line);
    }
  });

  it("says nothing about a brief when a ticket has none — existing tickets are untouched", () => {
    const markdown = taskMarkdown({ agentBrief: null }) ?? "";
    expect(markdown).toContain(HUMAN_BODY);
    expect(markdown).not.toContain("Agent brief");
  });

  it("carries the brief alone when a ticket is brief-only", () => {
    const markdown = taskMarkdown({ description: null }) ?? "";
    expect(markdown).not.toContain("Issue description:");
    expect(markdown).toContain("Agent brief");
    expect(markdown).toContain("apex run penpot update-file --output json");
  });

  it("exposes the brief to flow prompt templates as {{agent_brief}}", () => {
    const rendered = renderAgentPrompt("do it:\n{{agent_brief}}", {
      identifier: "APE-5",
      title: "t",
      description: HUMAN_BODY,
      agentBrief: AGENT_BRIEF,
      issueId: "11111111-1111-1111-1111-111111111111",
      flowName: "design-change",
      nodeId: "board_diff",
      acceptance: "pr_exists:o/r#b",
    });
    expect(rendered).toBe(`do it:\n${AGENT_BRIEF}`);
    expect(
      renderAgentPrompt("{{agent_brief}}", {
        identifier: null,
        title: "t",
        description: null,
        agentBrief: null,
        issueId: "i",
        flowName: null,
        nodeId: "n",
        acceptance: "",
      }),
    ).toBe("");
  });
});

describe("the report instruction a bounded agent step is commissioned with", () => {
  const comment = buildAgentInstructionComment({
    flowName: "design-change",
    nodeId: "board_diff",
    renderedPrompt: "Author the design-board change.",
    acceptance: "pr_exists:sarala-ai/apex-design#design/APE-5",
    budget: { max_turns: 25 },
  });

  it("asks for one sentence of outcome, then only what the reader cannot see", () => {
    expect(comment).toContain(AGENT_STEP_REPORT_INSTRUCTION);
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("Post ONE short comment");
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("in one sentence");
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("could NOT already see");
  });

  it("forbids emoji checklists, restating the instruction, step lists, and pasted output", () => {
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("Do not use emoji or status checklists");
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("Do not restate this instruction");
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("Do not list the steps you took");
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain(
      "Do not paste command output, payloads, or diagnostics",
    );
  });

  it("sends blocked-step debugging to the run, not to the ticket conversation", () => {
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("If you are blocked");
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("the single thing that would unblock it");
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("stay in this run's transcript");
    expect(AGENT_STEP_REPORT_INSTRUCTION).toContain("do not paste it into the conversation");
  });

  it("keeps the instruction, acceptance, and budget the step already carried", () => {
    expect(comment).toContain("Author the design-board change.");
    expect(comment).toContain("Acceptance: pr_exists:sarala-ai/apex-design#design/APE-5");
    expect(comment).toContain('Budget (advisory in v1 — not runtime-enforced): {"max_turns":25}');
  });
});
