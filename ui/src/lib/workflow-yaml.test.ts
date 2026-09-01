import { describe, expect, it } from "vitest";
import {
  createStepDraft,
  emptyWorkflowDraft,
  isValidKebabName,
  kebabNameError,
  parseWorkflowYaml,
  serializeWorkflowDraft,
  type WorkflowDraft,
} from "./workflow-yaml";

describe("isValidKebabName / kebabNameError", () => {
  it("accepts lowercase kebab-case names", () => {
    expect(isValidKebabName("deploy-service")).toBe(true);
    expect(isValidKebabName("a")).toBe(true);
    expect(kebabNameError("deploy-service")).toBeNull();
  });

  it("rejects uppercase, spaces, underscores, and leading/trailing hyphens", () => {
    expect(isValidKebabName("Deploy-Service")).toBe(false);
    expect(isValidKebabName("deploy service")).toBe(false);
    expect(isValidKebabName("deploy_service")).toBe(false);
    expect(isValidKebabName("-deploy")).toBe(false);
    expect(isValidKebabName("deploy-")).toBe(false);
    expect(kebabNameError("Deploy Service")).toMatch(/kebab-case/);
  });

  it("requires a non-empty name", () => {
    expect(kebabNameError("")).toMatch(/required/);
    expect(kebabNameError("   ")).toMatch(/required/);
  });
});

describe("createStepDraft", () => {
  it("creates a step with a unique id and a sequential default name", () => {
    const first = createStepDraft(null, []);
    const second = createStepDraft(first.id, [first]);
    expect(first.id).not.toBe(second.id);
    expect(first.server_type).toBe("");
    expect(first.tool_name).toBe("");
    expect(first.parameters).toEqual({});
  });
});

describe("serializeWorkflowDraft / parseWorkflowYaml round trip", () => {
  function draftWithSteps(): WorkflowDraft {
    return {
      metadata: { name: "deploy-service", version: "1.0", lifecycle: "pipeline", description: "Deploys the service" },
      steps: [
        {
          id: "a",
          name: "build",
          server_type: "docker_operations",
          tool_name: "build_image",
          parameters: { dockerfile_path: ".", tag: "${image_tag}" },
        },
        {
          id: "b",
          name: "deploy",
          server_type: "workflow_engine",
          tool_name: "run",
          parameters: { workflow: "modules/deploy-container-service" },
        },
      ],
    };
  }

  it("serializes metadata, entry_point, and steps in apex-core's documented shape", () => {
    const yamlText = serializeWorkflowDraft(draftWithSteps());
    expect(yamlText).toContain("name: deploy-service");
    // js-yaml's default dump quotes a string like "1.0" with single quotes
    // (it would otherwise parse back as a number/incomplete scalar).
    expect(yamlText).toContain("version: '1.0'");
    expect(yamlText).toContain("lifecycle: pipeline");
    expect(yamlText).toContain("entry_point: build");
    expect(yamlText).toContain("server_type: docker_operations");
    expect(yamlText).toContain("tool_name: build_image");
  });

  it("omits description when blank and omits parameters when empty", () => {
    const draft = emptyWorkflowDraft();
    draft.metadata.name = "no-op";
    draft.steps = [{ id: "a", name: "noop", server_type: "devtools", tool_name: "noop", parameters: {} }];
    const yamlText = serializeWorkflowDraft(draft);
    expect(yamlText).not.toContain("description:");
    expect(yamlText).not.toContain("parameters:");
  });

  it("round-trips a full draft through serialize → parse (ignoring client-only ids)", () => {
    const original = draftWithSteps();
    const yamlText = serializeWorkflowDraft(original);
    const result = parseWorkflowYaml(yamlText);

    expect(result.ok).toBe(true);
    expect(result.draft!.metadata).toEqual(original.metadata);
    expect(
      result.draft!.steps.map(({ id: _id, ...rest }) => rest),
    ).toEqual(original.steps.map(({ id: _id, ...rest }) => rest));
  });

  it("assigns fresh ids to parsed steps rather than reusing any prior id", () => {
    const result = parseWorkflowYaml(serializeWorkflowDraft(draftWithSteps()));
    const ids = result.draft!.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
  });

  it("parses an empty document as an empty draft", () => {
    const result = parseWorkflowYaml("");
    expect(result.ok).toBe(true);
    expect(result.draft).toEqual(emptyWorkflowDraft());
  });

  it("reports a parse error for invalid YAML without throwing", () => {
    const result = parseWorkflowYaml("name: [unterminated");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("reports a shape error when the document is not a mapping", () => {
    const result = parseWorkflowYaml("- just\n- a\n- list\n");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/mapping/);
  });

  it("reports a shape error when `steps` is not a list", () => {
    const result = parseWorkflowYaml("name: x\nsteps: not-a-list\n");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/steps/);
  });

  it("tolerates a step missing `parameters` (defaults to empty object)", () => {
    const result = parseWorkflowYaml("name: x\nsteps:\n  - name: only_name\n");
    expect(result.ok).toBe(true);
    expect(result.draft!.steps[0].parameters).toEqual({});
  });
});
