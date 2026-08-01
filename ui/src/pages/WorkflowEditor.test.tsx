// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowValidateResponse } from "@paperclipai/shared";
import {
  WorkflowEditorForm,
  draftFromWorkflowDetail,
  referencesForStepIndex,
} from "./WorkflowEditor";
import { emptyWorkflowDraft, type WorkflowDraft } from "@/lib/workflow-yaml";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function draftWithTwoSteps(): WorkflowDraft {
  return {
    metadata: { name: "deploy-service", version: "1.0", lifecycle: "pipeline", description: "" },
    steps: [
      { id: "s1", name: "build", server_type: "docker_operations", tool_name: "build_image", parameters: {} },
      { id: "s2", name: "deploy", server_type: "workflow_engine", tool_name: "run", parameters: {} },
    ],
  };
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickButtonWithText(container: HTMLDivElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button found with text "${text}"`);
  return act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Radix's TabsTrigger (default `activationMode="automatic"`) switches on
 *  *focus*, not click — its real pointer handler calls `.focus()` from
 *  `onMouseDown` and the actual tab change happens in `onFocus`. A bare
 *  "click" dispatch never focuses the element in jsdom, so tab-switching
 *  tests must reproduce the mousedown → focus → click sequence a real
 *  pointer interaction produces. */
function clickTab(container: HTMLDivElement, tabText: string) {
  const trigger = Array.from(container.querySelectorAll('button[role="tab"]')).find((b) =>
    b.textContent?.includes(tabText),
  ) as HTMLButtonElement | undefined;
  if (!trigger) throw new Error(`No tab trigger found with text "${tabText}"`);
  return act(async () => {
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("referencesForStepIndex", () => {
  it("offers only preceding steps, keyed off the ${stepname.output} convention", () => {
    const steps = draftWithTwoSteps().steps;
    expect(referencesForStepIndex(steps, 0)).toEqual([]);
    expect(referencesForStepIndex(steps, 1)).toEqual([{ label: "build → output", value: "${build.output}" }]);
  });

  it("skips steps with a blank name", () => {
    const steps = [
      { id: "a", name: "", server_type: "", tool_name: "", parameters: {} },
      { id: "b", name: "second", server_type: "", tool_name: "", parameters: {} },
    ];
    expect(referencesForStepIndex(steps, 2)).toEqual([{ label: "second → output", value: "${second.output}" }]);
  });
});

describe("draftFromWorkflowDetail", () => {
  it("parses definition_yaml for steps/parameters but prefers the top-level metadata fields", () => {
    const detail = {
      status: "success" as const,
      name: "deploy-cloudrun",
      version: "1.2.0",
      lifecycle: "stable",
      description: "Deploys a service.",
      path: "/builtin/deploy-cloudrun.yaml",
      source: "apex-core",
      layer: "built-in",
      inputs: [],
      steps: [],
      outputs: [],
      definition_yaml: "name: mismatched-name\nsteps:\n  - name: build\n    server_type: gcp\n    tool_name: build_image\n    parameters:\n      tag: latest\n",
      footprint: { resources: [], count: 0, note: "note" },
    };
    const draft = draftFromWorkflowDetail(detail);
    expect(draft.metadata).toEqual({
      name: "deploy-cloudrun",
      version: "1.2.0",
      lifecycle: "stable",
      description: "Deploys a service.",
    });
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]).toMatchObject({
      name: "build",
      server_type: "gcp",
      tool_name: "build_image",
      parameters: { tag: "latest" },
    });
  });
});

describe("WorkflowEditorForm", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function renderForm(initialDraft: WorkflowDraft, onValidate = vi.fn()) {
    await act(async () => {
      root.render(
        <WorkflowEditorForm mode="new" initialDraft={initialDraft} onValidate={onValidate} onBack={() => {}} />,
      );
    });
    return { onValidate };
  }

  it("shows a kebab-case validation error for an invalid workflow name", async () => {
    const draft = emptyWorkflowDraft();
    draft.metadata.name = "Not Kebab";
    await renderForm(draft);
    expect(container.textContent).toContain("kebab-case");
  });

  it("shows no name error for a valid kebab-case name", async () => {
    const draft = emptyWorkflowDraft();
    draft.metadata.name = "deploy-service";
    await renderForm(draft);
    expect(container.textContent).not.toContain("kebab-case");
  });

  it("adds a first step via the empty-state control and selects it", async () => {
    await renderForm(emptyWorkflowDraft());
    expect(container.textContent).toContain("No items yet.");
    await clickButtonWithText(container, "Add first item");
    expect(container.querySelector("[id^='step-name-']")).not.toBeNull();
  });

  it("reorders steps via the move-later control", async () => {
    await renderForm(draftWithTwoSteps());
    const moveLater = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Move later",
    ) as HTMLButtonElement;
    await act(async () => {
      moveLater.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The form-tab YAML preview reflects the reordered entry_point.
    expect(container.textContent).toContain("entry_point: deploy");
  });

  it("edits a step's name/server_type/tool_name through the detail form", async () => {
    const draft = draftWithTwoSteps();
    await renderForm(draft);
    const card = container.querySelector('[data-testid="step-card-s1"]')!.closest("button")!;
    await act(async () => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const toolInput = container.querySelector("#step-tool-s1") as HTMLInputElement;
    await act(async () => {
      setInputValue(toolInput, "push_image");
    });
    expect(container.textContent).toContain("tool_name: push_image");
  });

  it("adds a parameter via the key/value fallback editor and reflects it in the YAML", async () => {
    const draft = draftWithTwoSteps();
    await renderForm(draft);
    const card = container.querySelector('[data-testid="step-card-s1"]')!.closest("button")!;
    await act(async () => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await clickButtonWithText(container, "Add parameter");
    const keyInput = container.querySelector('input[aria-label="Parameter name"]') as HTMLInputElement;
    expect(keyInput).not.toBeNull();
    await act(async () => {
      setInputValue(keyInput, "dockerfile_path");
    });
    const valueInput = container.querySelector('input[aria-label="Value for dockerfile_path"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(valueInput, ".");
    });
    expect(container.textContent).toContain("dockerfile_path");
    // Confirm it round-trips into the serialized definition.
    const preview = container.querySelector("pre")!;
    expect(preview.textContent).toContain("dockerfile_path");
  });

  it("offers a prior step's output as an expression reference on a later step's parameter", async () => {
    const draft = draftWithTwoSteps();
    draft.steps[1].parameters = { image: "" };
    await renderForm(draft);
    const card = container.querySelector('[data-testid="step-card-s2"]')!.closest("button")!;
    await act(async () => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const referenceToggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Reference") && !b.disabled,
    ) as HTMLButtonElement;
    expect(referenceToggle).not.toBeUndefined();
    await act(async () => {
      referenceToggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    const optionLabels = Array.from(select.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionLabels).toContain("build → output");
  });

  it("wires the Validate button to the injected onValidate and renders a valid result", async () => {
    const onValidate = vi.fn(async (): Promise<WorkflowValidateResponse> => ({ valid: true, errors: [], warnings: [] }));
    await renderForm(draftWithTwoSteps(), onValidate);
    await clickButtonWithText(container, "Validate");
    expect(onValidate).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Valid");
  });

  it("renders errors/warnings from an invalid validation result", async () => {
    const onValidate = vi.fn(
      async (): Promise<WorkflowValidateResponse> => ({
        valid: false,
        errors: ["Unknown tool 'frobnicate' on server 'docker_operations'."],
        warnings: ["Step 'deploy' has no inputs referenced."],
      }),
    );
    await renderForm(draftWithTwoSteps(), onValidate);
    await clickButtonWithText(container, "Validate");
    expect(container.textContent).toContain("Invalid");
    expect(container.textContent).toContain("Unknown tool 'frobnicate'");
    expect(container.textContent).toContain("no inputs referenced");
  });

  it("renders a degraded-CLI validation error the same way as the read pages", async () => {
    const onValidate = vi.fn(
      async (): Promise<WorkflowValidateResponse> => ({
        status: "error",
        error_type: "cli_missing",
        message: "The `apex` CLI is not installed or not on PATH.",
        remediation: "Install apex-platform.",
      }),
    );
    await renderForm(draftWithTwoSteps(), onValidate);
    await clickButtonWithText(container, "Validate");
    expect(container.textContent).toContain("not installed or not on PATH");
    expect(container.textContent).toContain("cli_missing");
  });

  it("switching to the raw YAML tab does not silently sync later form edits into the textarea", async () => {
    await renderForm(draftWithTwoSteps());
    await clickTab(container, "Raw YAML");
    const textarea = container.querySelector('textarea[aria-label="Raw workflow YAML"]') as HTMLTextAreaElement;
    expect(textarea.value).toContain("name: deploy-service");

    // Go back to form and change the name — the already-open raw tab's
    // captured text must NOT change until the user explicitly reloads it.
    await clickTab(container, "Form");
    const nameInput = container.querySelector("#workflow-name") as HTMLInputElement;
    await act(async () => {
      setInputValue(nameInput, "renamed-workflow");
    });
    await clickTab(container, "Raw YAML");
    const textareaAfter = container.querySelector('textarea[aria-label="Raw workflow YAML"]') as HTMLTextAreaElement;
    expect(textareaAfter.value).toContain("name: deploy-service");
    expect(textareaAfter.value).not.toContain("renamed-workflow");

    await clickButtonWithText(container, "Reload from form");
    const textareaReloaded = container.querySelector('textarea[aria-label="Raw workflow YAML"]') as HTMLTextAreaElement;
    expect(textareaReloaded.value).toContain("renamed-workflow");
  });

  it("applies raw YAML edits to the form model only when explicitly asked", async () => {
    await renderForm(draftWithTwoSteps());
    await clickTab(container, "Raw YAML");
    const textarea = container.querySelector('textarea[aria-label="Raw workflow YAML"]') as HTMLTextAreaElement;
    await act(async () => {
      setInputValue(textarea, "name: applied-name\nversion: \"2.0\"\nlifecycle: pipeline\nsteps: []\n");
    });

    await clickTab(container, "Form");
    expect(container.querySelector("#workflow-name") as HTMLInputElement).toHaveProperty("value", "deploy-service");

    await clickTab(container, "Raw YAML");
    await clickButtonWithText(container, "Apply raw edits to form");
    await clickTab(container, "Form");
    const nameInput = container.querySelector("#workflow-name") as HTMLInputElement;
    expect(nameInput.value).toBe("applied-name");
  });

  it("shows a parse error and does not touch the form model on invalid raw YAML", async () => {
    await renderForm(draftWithTwoSteps());
    await clickTab(container, "Raw YAML");
    const textarea = container.querySelector('textarea[aria-label="Raw workflow YAML"]') as HTMLTextAreaElement;
    await act(async () => {
      setInputValue(textarea, "name: [unterminated");
    });
    await clickButtonWithText(container, "Apply raw edits to form");
    expect(container.textContent).toMatch(/could not parse|end of the stream|unexpected/i);

    await clickTab(container, "Form");
    const nameInput = container.querySelector("#workflow-name") as HTMLInputElement;
    expect(nameInput.value).toBe("deploy-service");
  });

  it("always shows the honest publish-lands-next banner", async () => {
    await renderForm(draftWithTwoSteps());
    expect(container.textContent).toContain("publishing straight to git from here");
  });
});
