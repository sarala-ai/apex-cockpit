/**
 * `findChangeRequestTarget` — where a `request_changes` decision sends the work.
 *
 * Carried over from `flow-request-changes.test.ts` when the flow front-end was
 * deleted. The rule itself never belonged to that front-end: it lives in
 * `apex/steps/process-definition.ts` precisely so the host that re-arms the
 * step and the decision brief that TELLS the founder what will happen agree.
 * Divergence between those two is a lie in the UI, so the rule keeps its own
 * tests rather than being exercised only through whichever host is running.
 *
 * Everything else in the old file exercised the coordinator's execution of
 * that routing, which the pipeline host now owns and covers
 * (pipelines-service.test.ts, pipeline-agent-step-executor.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  findChangeRequestTarget,
  type ProcessDefinition,
  type ProcessStep,
} from "../apex/steps/process-definition.js";

function agentStep(id: string): ProcessStep {
  return {
    id,
    kind: "agent",
    agent: { prompt_template: `do ${id}` },
    on_fail: "pause",
  };
}

function runStep(id: string): ProcessStep {
  return {
    id,
    kind: "run",
    run: { target: { type: "command", tool: "pnpm", args: ["test"] } },
    on_fail: "pause",
  };
}

function gateStep(id: string, gateExtras: Record<string, unknown> = {}): ProcessStep {
  return {
    id,
    kind: "gate",
    gate: { mode: "approve", prompt: "Check", ...gateExtras },
    on_fail: "pause",
  } as ProcessStep;
}

function processOf(name: string, steps: ProcessStep[]): ProcessDefinition {
  return { name, version: "1.0", description: "", ticket_type: "feature", steps };
}

/** An authoring step, then deterministic steps, then the gate — the shape that
 *  proves a `run` step is stepped OVER rather than treated as an author. */
const withRunSteps = (gateExtras: Record<string, unknown> = {}) =>
  processOf("checked", [
    agentStep("tasks"),
    runStep("task_checks"),
    gateStep("diff_gate", gateExtras),
  ]);

/** The feature lifecycle's `promote`: a gate at index 0, nothing before it. */
const gateFirst = () => processOf("promote-first", [gateStep("promote"), agentStep("spec")]);

/** Two authoring steps before one gate — proves "nearest prior", not "first". */
const twoAuthors = (gateExtras: Record<string, unknown> = {}) =>
  processOf("two-authors", [agentStep("spec"), agentStep("design"), gateStep("gate", gateExtras)]);

describe("findChangeRequestTarget — the routing rule", () => {
  it("derives the NEAREST prior agent step, not the first", () => {
    const target = findChangeRequestTarget(twoAuthors(), "gate");
    expect(target).toMatchObject({ found: true, source: "derived", index: 1 });
    if (target.found) expect(target.step.id).toBe("design");
  });

  it("skips over deterministic run steps to reach the authoring step", () => {
    const target = findChangeRequestTarget(withRunSteps(), "diff_gate");
    expect(target).toMatchObject({ found: true, source: "derived" });
    if (target.found) expect(target.step.id).toBe("tasks");
  });

  it("a declared request_changes_to wins over the derived nearest", () => {
    const target = findChangeRequestTarget(twoAuthors({ request_changes_to: "spec" }), "gate");
    expect(target).toMatchObject({ found: true, source: "declared" });
    if (target.found) expect(target.step.id).toBe("spec");
  });

  it("a declared target that does not exist is classified, never a silent fallback", () => {
    expect(findChangeRequestTarget(twoAuthors({ request_changes_to: "ghost" }), "gate")).toEqual({
      found: false,
      reason: "declared_target_missing",
    });
  });

  it("a declared target that is not an agent step is classified", () => {
    expect(
      findChangeRequestTarget(withRunSteps({ request_changes_to: "task_checks" }), "diff_gate"),
    ).toEqual({ found: false, reason: "declared_target_not_agent" });
  });

  it("a gate with no agent step before it has no target", () => {
    expect(findChangeRequestTarget(gateFirst(), "promote")).toEqual({
      found: false,
      reason: "no_prior_agent_step",
    });
  });

  it("a gate key that names no step is classified rather than matched by position", () => {
    expect(findChangeRequestTarget(twoAuthors(), "not-a-step")).toEqual({
      found: false,
      reason: "no_prior_agent_step",
    });
  });
});
