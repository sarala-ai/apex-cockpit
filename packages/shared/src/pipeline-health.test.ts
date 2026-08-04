import { describe, expect, it } from "vitest";
import {
  computePipelineHealth,
  type PipelineHealthFailedAutomationInput,
  type PipelineHealthInput,
} from "./pipeline-health.js";

describe("computePipelineHealth", () => {
  const baseInput: PipelineHealthInput = {
    pipelineId: "pipeline-1",
    stages: [],
    agentsById: {},
    pipelinesById: {},
  };

  it("emits one warning per failed automation item and stage", () => {
    const failure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [failure],
    });

    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatchObject({
      code: "automation_failed",
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      href: "/pipelines/pipeline-1/items/case-1",
      hrefLabel: "Open item",
      message: `Automation failed on "Case 1". Open the item to inspect the log and retry it.`,
    });
  });

  it("deduplicates duplicate failed automation rows for the same stage and case", () => {
    const failure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const duplicateFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [failure, duplicateFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(1);
  });

  it("keeps separate warnings for different case IDs in the same stage", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-2",
      caseTitle: "Case 2",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.href)).toEqual([
      "/pipelines/pipeline-1/items/case-1",
      "/pipelines/pipeline-1/items/case-2",
    ]);
  });

  it("keeps separate warnings for the same case ID in different stages", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-1",
      stageKey: "build",
      stageName: "Build",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage-2",
      stageKey: "verify",
      stageName: "Verify",
      caseId: "case-1",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.stageId)).toEqual(["stage-1", "stage-2"]);
  });

  it("keeps separate warnings when stage and case IDs would collide with colon-delimited keys", () => {
    const firstFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage:one",
      stageKey: "build",
      stageName: "Build",
      caseId: "case",
      caseTitle: "Case 1",
      error: "Routine timed out",
    };
    const secondFailure: PipelineHealthFailedAutomationInput = {
      stageId: "stage",
      stageKey: "verify",
      stageName: "Verify",
      caseId: "one:case",
      caseTitle: "Case 2",
      error: "Routine timed out",
    };

    const report = computePipelineHealth({
      ...baseInput,
      failedAutomations: [firstFailure, secondFailure],
    });

    const automationWarnings = report.warnings.filter((warning) => warning.code === "automation_failed");

    expect(automationWarnings).toHaveLength(2);
    expect(automationWarnings.map((warning) => warning.href)).toEqual([
      "/pipelines/pipeline-1/items/case",
      "/pipelines/pipeline-1/items/one:case",
    ]);
  });
});

/*
 * The seeded lifecycles run their work through `onEnter: {type: "agent"}` and
 * `{type: "run"}` — the step model is `run · agent · gate`. This predicate
 * originally recognised only `routine`, which was the entire union before that
 * change, so every seeded lifecycle rendered "Some steps won't run yet — 4
 * things to fix" over stages that were correctly wired. A health panel that
 * cries wolf about valid configuration is worse than none, because the next
 * warning is the one nobody reads.
 */
describe("stage automation detection across all onEnter kinds", () => {
  const stage = (config: Record<string, unknown>) => ({
    pipelineId: "pipeline-1",
    stages: [{ id: "s1", key: "spec", name: "Spec", kind: "working", config }],
    agentsById: {},
    pipelinesById: {},
  });

  const noAutomationWarnings = (config: Record<string, unknown>) =>
    computePipelineHealth(stage(config)).warnings.filter((w) => w.code === "stage_no_automation");

  it("counts an agent step declared by roster key as runnable", () => {
    expect(noAutomationWarnings({ onEnter: { type: "agent", agentKey: "specifier" } })).toHaveLength(0);
  });

  it("counts an agent step declared by explicit id as runnable", () => {
    expect(noAutomationWarnings({ onEnter: { type: "agent", agentId: "agent-1" } })).toHaveLength(0);
  });

  it("counts a run step with a target as runnable", () => {
    expect(
      noAutomationWarnings({ onEnter: { type: "run", target: { type: "workflow", workflow: "deploy" } } }),
    ).toHaveLength(0);
  });

  it("still counts a routine step as runnable", () => {
    expect(noAutomationWarnings({ onEnter: { type: "routine", routineId: "r1" } })).toHaveLength(0);
  });

  /* The warning must survive for stages that genuinely will not run — an
   * agent step naming nobody, and a run step with nothing to run. */
  it("still warns when an agent step names no agent", () => {
    expect(noAutomationWarnings({ onEnter: { type: "agent" } })).toHaveLength(1);
  });

  it("still warns when a run step declares no target", () => {
    expect(noAutomationWarnings({ onEnter: { type: "run" } })).toHaveLength(1);
  });

  it("still warns when a stage has no onEnter at all", () => {
    expect(noAutomationWarnings({})).toHaveLength(1);
  });
});
