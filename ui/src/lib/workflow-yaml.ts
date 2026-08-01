// Workflow builder's canonical in-memory model + the serializer/parser pair
// that bridges it to apex-core's real DSL shape (verified live against
// apex/core/workflows/ci/deploy-pipeline.yml and platform/simple_web_stack.yaml):
//
//   name: <kebab-case>
//   version: "<string>"
//   lifecycle: <string>
//   description: "<string>"
//   entry_point: <first step's name>
//   steps:
//     - name: <string>
//       server_type: <string>
//       tool_name: <string>
//       parameters: { ... }
//
// The form is the single source of truth (`WorkflowDraft`). Raw YAML is a
// derived view: `serializeWorkflowDraft` renders it on demand, and
// `parseWorkflowYaml` only replaces the draft when the caller explicitly
// applies raw edits (see WorkflowEditor's "Apply raw edits" action) — there
// is no silent bidirectional sync between the two.
import yaml from "js-yaml";

export interface WorkflowStepDraft {
  /** Client-only identity for OrderedItemEditor/React keys — never
   *  serialized. */
  id: string;
  name: string;
  server_type: string;
  tool_name: string;
  parameters: Record<string, unknown>;
}

export interface WorkflowMetadataDraft {
  name: string;
  version: string;
  lifecycle: string;
  description: string;
}

export interface WorkflowDraft {
  metadata: WorkflowMetadataDraft;
  steps: WorkflowStepDraft[];
}

export const DEFAULT_LIFECYCLE = "pipeline";

let localIdCounter = 0;
/** Overridable in tests for deterministic ids; production default is a
 *  monotonic counter (no crypto dependency needed for a client-only key). */
export function nextLocalId(): string {
  localIdCounter += 1;
  return `step-local-${localIdCounter}`;
}

export function emptyWorkflowDraft(): WorkflowDraft {
  return {
    metadata: { name: "", version: "1.0", lifecycle: DEFAULT_LIFECYCLE, description: "" },
    steps: [],
  };
}

export function createStepDraft(afterId: string | null, steps: WorkflowStepDraft[]): WorkflowStepDraft {
  const index = afterId ? steps.findIndex((s) => s.id === afterId) : -1;
  const stepNumber = steps.length + 1;
  return {
    id: nextLocalId(),
    name: `step-${stepNumber}`,
    server_type: "",
    tool_name: "",
    parameters: {},
  };
  // `index` is unused for naming (kept simple/sequential) but the parameter
  // keeps the signature ready if numbering-by-position is wanted later.
  void index;
}

// ── Name validation ──────────────────────────────────────────────────────

const KEBAB_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidKebabName(name: string): boolean {
  return KEBAB_PATTERN.test(name);
}

export function kebabNameError(name: string): string | null {
  if (name.trim().length === 0) return "Name is required.";
  if (!isValidKebabName(name)) {
    return "Must be lowercase kebab-case (letters, digits, single hyphens — e.g. \"deploy-service\").";
  }
  return null;
}

// ── Serialize (draft → YAML string) ─────────────────────────────────────

export function serializeWorkflowDraft(draft: WorkflowDraft): string {
  const { metadata, steps } = draft;
  const doc: Record<string, unknown> = {
    name: metadata.name,
    version: metadata.version,
    lifecycle: metadata.lifecycle,
  };
  if (metadata.description.trim().length > 0) {
    doc.description = metadata.description;
  }
  if (steps.length > 0) {
    doc.entry_point = steps[0].name;
  }
  doc.steps = steps.map((step) => {
    const stepDoc: Record<string, unknown> = {
      name: step.name,
      server_type: step.server_type,
      tool_name: step.tool_name,
    };
    if (Object.keys(step.parameters).length > 0) {
      stepDoc.parameters = step.parameters;
    }
    return stepDoc;
  });
  return yaml.dump(doc, { noRefs: true, lineWidth: -1 });
}

// ── Parse (YAML string → draft) ──────────────────────────────────────────

export interface ParseWorkflowYamlResult {
  ok: boolean;
  draft?: WorkflowDraft;
  error?: string;
}

function coerceString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** Tolerant parse of apex-core's workflow YAML shape into the builder's
 *  draft model. Never throws — parse/shape problems come back as
 *  `{ok:false,error}` so the caller can show an inline banner without
 *  losing the user's raw text. */
export function parseWorkflowYaml(source: string): ParseWorkflowYamlResult {
  let parsed: unknown;
  try {
    parsed = yaml.load(source);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not parse YAML." };
  }

  if (parsed === null || parsed === undefined) {
    return { ok: true, draft: emptyWorkflowDraft() };
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "A workflow document must be a YAML mapping at the top level." };
  }

  const root = parsed as Record<string, unknown>;
  const metadata: WorkflowMetadataDraft = {
    name: coerceString(root.name),
    version: coerceString(root.version, "1.0"),
    lifecycle: coerceString(root.lifecycle, DEFAULT_LIFECYCLE),
    description: coerceString(root.description),
  };

  const rawSteps = root.steps;
  if (rawSteps !== undefined && !Array.isArray(rawSteps)) {
    return { ok: false, error: "`steps` must be a list of step objects." };
  }

  const steps: WorkflowStepDraft[] = (Array.isArray(rawSteps) ? rawSteps : []).map((raw) => {
    const stepObj = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const parameters =
      stepObj.parameters && typeof stepObj.parameters === "object" && !Array.isArray(stepObj.parameters)
        ? (stepObj.parameters as Record<string, unknown>)
        : {};
    return {
      id: nextLocalId(),
      name: coerceString(stepObj.name),
      server_type: coerceString(stepObj.server_type),
      tool_name: coerceString(stepObj.tool_name),
      parameters,
    };
  });

  return { ok: true, draft: { metadata, steps } };
}
