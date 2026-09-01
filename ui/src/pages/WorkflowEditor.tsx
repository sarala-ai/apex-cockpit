// WorkflowEditor — the authoring surface over the Workflows/WorkflowDetail
// read pages (builder plan session 4). Assembles prior groundwork:
// OrderedItemEditor (step list + detail slot + unsaved bar),
// ExpressionInput + JsonSchemaForm's fieldOverrides (step parameters),
// POST /apex/workflows/validate (server/src/routes/apex-workflows.ts), and
// the same degraded-CLI honesty as Workflows.tsx/WorkflowDetail.tsx.
//
// Session scope: authoring + validation + Download/Copy YAML only. There is
// NO publish/save-to-git here — that's a separate session (the git-catalog
// spine). See `PublishBanner` below.
//
// Tool catalog decision (checked live against
// apex/core/config/platform_control.yaml, read-only): the only resource
// server that could plausibly expose a "list tools" capability is
// `platform_control`, and its actual tool set is
// set_platform_mode/get_platform_status/get_platform_health/get_platform_info
// — no list-tools tool exists anywhere in apex-core as of this session. A new
// GET /apex/workflows/toolcatalog route would have nothing real to shell out
// to, so per this session's brief we do NOT invent a core change: server_type
// and tool_name are free-text inputs, and step parameters fall back to a
// key/value editor (see WorkflowStepParametersEditor). The schema-driven path
// (JsonSchemaForm + fieldOverrides + ExpressionInput) is fully wired and
// tested for when a catalog route does land — `getToolSchemaForStep` below is
// the single seam to fill in.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, CheckCircle2, Clipboard, Download, Loader2 } from "lucide-react";
import { Link, useNavigate, useParams } from "@/lib/router";
import { workflowsApi } from "@/api/workflows";
import { useCompany } from "../context/CompanyContext";
import { WorkflowsErrorState } from "./Workflows";
import { OrderedItemEditor } from "@/components/OrderedItemEditor";
import { WorkflowStepParametersEditor } from "@/components/WorkflowStepParametersEditor";
import type { ExpressionReference } from "@/components/ExpressionInput";
import type { JsonSchemaNode } from "@/components/JsonSchemaForm";
import { InlineBanner } from "@/components/InlineBanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createStepDraft,
  emptyWorkflowDraft,
  kebabNameError,
  parseWorkflowYaml,
  serializeWorkflowDraft,
  type WorkflowDraft,
  type WorkflowStepDraft,
} from "@/lib/workflow-yaml";
import type { WorkflowDetailResponse, WorkflowValidateResponse } from "@paperclipai/shared";

/** Seam for a future tool catalog. Always undefined today — see the module
 *  doc for why no route was added this session. */
export function getToolSchemaForStep(_serverType: string, _toolName: string): JsonSchemaNode | undefined {
  return undefined;
}

/** Prior-step output references offered to a step at `stepIndex` — only
 *  steps earlier in the list (no forward/self references). */
export function referencesForStepIndex(steps: WorkflowStepDraft[], stepIndex: number): ExpressionReference[] {
  return steps
    .slice(0, stepIndex)
    .filter((s) => s.name.trim().length > 0)
    .map((s) => ({ label: `${s.name} → output`, value: `\${${s.name}.output}` }));
}

/** Builds the starting draft for edit mode from a loaded WorkflowDetailResponse
 *  — parses `definition_yaml` for full step fidelity (parameters aren't in
 *  the flattened `steps[]` summary), then overrides metadata with the
 *  authoritative top-level fields the CLI already parsed. */
export function draftFromWorkflowDetail(data: Extract<WorkflowDetailResponse, { status: "success" }>): WorkflowDraft {
  const parsed = parseWorkflowYaml(data.definition_yaml);
  const base = parsed.ok && parsed.draft ? parsed.draft : emptyWorkflowDraft();
  return {
    ...base,
    metadata: {
      name: data.name,
      version: data.version ?? "1.0",
      lifecycle: data.lifecycle,
      description: data.description ?? "",
    },
  };
}

function PublishBanner() {
  return (
    <InlineBanner tone="info" title="This builder ends at validated YAML.">
      Download or copy the YAML below and commit it yourself for now — publishing straight to git from here
      is a separate piece of work landing next.
    </InlineBanner>
  );
}

function downloadYamlFile(name: string, yamlText: string) {
  const blob = new Blob([yamlText], { type: "text/yaml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name.trim() || "workflow"}.yaml`;
  a.click();
  URL.revokeObjectURL(url);
}

export interface WorkflowEditorFormProps {
  mode: "new" | "edit";
  initialDraft: WorkflowDraft;
  onValidate: (yaml: string) => Promise<WorkflowValidateResponse>;
  onBack?: () => void;
}

export function WorkflowEditorForm({ mode, initialDraft, onValidate, onBack }: WorkflowEditorFormProps) {
  const [draft, setDraft] = useState<WorkflowDraft>(initialDraft);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(initialDraft.steps[0]?.id ?? null);
  const [tab, setTab] = useState<"form" | "yaml">("form");
  const [rawYaml, setRawYaml] = useState<string>(() => serializeWorkflowDraft(initialDraft));
  const [parseError, setParseError] = useState<string | null>(null);
  const [validation, setValidation] = useState<WorkflowValidateResponse | null>(null);
  const [validating, setValidating] = useState(false);

  const initialSnapshot = useRef(JSON.stringify(initialDraft));
  const isDirty = JSON.stringify(draft) !== initialSnapshot.current;

  const nameError = kebabNameError(draft.metadata.name);

  const selectedIndex = draft.steps.findIndex((s) => s.id === selectedStepId);

  function updateStep(id: string, patch: Partial<WorkflowStepDraft>) {
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  }

  function reloadRawFromForm() {
    setRawYaml(serializeWorkflowDraft(draft));
    setParseError(null);
  }

  function applyRawEdits() {
    const result = parseWorkflowYaml(rawYaml);
    if (!result.ok || !result.draft) {
      setParseError(result.error ?? "Could not parse YAML.");
      return;
    }
    setDraft(result.draft);
    setSelectedStepId(result.draft.steps[0]?.id ?? null);
    setParseError(null);
  }

  function currentYaml(): string {
    return tab === "yaml" ? rawYaml : serializeWorkflowDraft(draft);
  }

  async function handleValidate() {
    setValidating(true);
    try {
      const result = await onValidate(currentYaml());
      setValidation(result);
    } finally {
      setValidating(false);
    }
  }

  function handleDownload() {
    downloadYamlFile(draft.metadata.name, currentYaml());
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(currentYaml());
    } catch {
      // Clipboard permission denial isn't actionable here beyond leaving the
      // text selectable in the raw tab — nothing to surface as an error.
    }
  }

  return (
    <div className="space-y-4 p-4">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3 w-3" />
        Back to Workflows
      </button>

      <h1 className="text-lg font-semibold">
        {mode === "new" ? "New workflow" : `Edit ${initialDraft.metadata.name || "workflow"}`}
      </h1>

      <PublishBanner />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Metadata</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="workflow-name">Name</Label>
            <Input
              id="workflow-name"
              value={draft.metadata.name}
              onChange={(e) => setDraft((d) => ({ ...d, metadata: { ...d.metadata, name: e.target.value } }))}
              aria-invalid={!!nameError}
              placeholder="deploy-service"
            />
            {nameError && <p className="text-xs font-medium text-destructive">{nameError}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-version">Version</Label>
            <Input
              id="workflow-version"
              value={draft.metadata.version}
              onChange={(e) => setDraft((d) => ({ ...d, metadata: { ...d.metadata, version: e.target.value } }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="workflow-lifecycle">Lifecycle</Label>
            <Input
              id="workflow-lifecycle"
              value={draft.metadata.lifecycle}
              onChange={(e) => setDraft((d) => ({ ...d, metadata: { ...d.metadata, lifecycle: e.target.value } }))}
              placeholder="pipeline"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="workflow-description">Description</Label>
            <Textarea
              id="workflow-description"
              value={draft.metadata.description}
              onChange={(e) => setDraft((d) => ({ ...d, metadata: { ...d.metadata, description: e.target.value } }))}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Steps</CardTitle>
        </CardHeader>
        <CardContent>
          <OrderedItemEditor<WorkflowStepDraft>
            items={draft.steps}
            onItemsChange={(steps) => setDraft((d) => ({ ...d, steps }))}
            selectedId={selectedStepId}
            onSelectedIdChange={setSelectedStepId}
            createItem={(afterId) => createStepDraft(afterId, draft.steps)}
            itemsAriaLabel="Workflow steps"
            renderItem={(step) => (
              <div className="space-y-0.5" data-testid={`step-card-${step.id}`}>
                <div className="font-medium">{step.name || "(unnamed step)"}</div>
                {(step.server_type || step.tool_name) && (
                  <div className="font-mono text-xs text-muted-foreground">
                    {step.server_type || "?"}.{step.tool_name || "?"}
                  </div>
                )}
              </div>
            )}
            renderDetail={(step, index) => {
              const schema = getToolSchemaForStep(step.server_type, step.tool_name);
              const references = referencesForStepIndex(draft.steps, index);
              return (
                <div className="space-y-4 rounded-lg border p-4">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5">
                      <Label htmlFor={`step-name-${step.id}`}>Step name</Label>
                      <Input
                        id={`step-name-${step.id}`}
                        value={step.name}
                        onChange={(e) => updateStep(step.id, { name: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`step-server-${step.id}`}>Server type</Label>
                      <Input
                        id={`step-server-${step.id}`}
                        value={step.server_type}
                        onChange={(e) => updateStep(step.id, { server_type: e.target.value })}
                        placeholder="e.g. docker_operations"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`step-tool-${step.id}`}>Tool name</Label>
                      <Input
                        id={`step-tool-${step.id}`}
                        value={step.tool_name}
                        onChange={(e) => updateStep(step.id, { tool_name: e.target.value })}
                        placeholder="e.g. build_image"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    No live tool catalog yet — server/tool are free text. TODO: replace with pickers once a
                    catalog route exists.
                  </p>
                  <div>
                    <Label className="mb-2 block">Parameters</Label>
                    <WorkflowStepParametersEditor
                      schema={schema}
                      parameters={step.parameters}
                      onChange={(parameters) => updateStep(step.id, { parameters })}
                      references={references}
                    />
                  </div>
                </div>
              );
            }}
            unsavedBar={
              isDirty ? (
                <p className="text-xs text-muted-foreground">
                  Unsaved changes — validate and download when ready; nothing here autosaves.
                </p>
              ) : null
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Definition</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Tabs value={tab} onValueChange={(v) => setTab(v as "form" | "yaml")}>
            <TabsList>
              <TabsTrigger value="form">Form</TabsTrigger>
              <TabsTrigger value="yaml">Raw YAML</TabsTrigger>
            </TabsList>
            <TabsContent value="form">
              <pre className="max-h-(--sz-240px) overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
                {serializeWorkflowDraft(draft)}
              </pre>
            </TabsContent>
            <TabsContent value="yaml" className="space-y-2">
              <Textarea
                value={rawYaml}
                onChange={(e) => setRawYaml(e.target.value)}
                className="min-h-(--sz-240px) font-mono text-xs"
                aria-label="Raw workflow YAML"
              />
              {parseError && <p className="text-xs font-medium text-destructive">{parseError}</p>}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={reloadRawFromForm}>
                  Reload from form
                </Button>
                <Button type="button" size="sm" onClick={applyRawEdits}>
                  Apply raw edits to form
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Editing here never silently syncs back to the form — click "Apply raw edits" to replace the
                form state with what's in this box.
              </p>
            </TabsContent>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Button type="button" onClick={handleValidate} disabled={validating}>
              {validating ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Validate
            </Button>
            <Button type="button" variant="outline" onClick={handleDownload}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download YAML
            </Button>
            <Button type="button" variant="outline" onClick={handleCopy}>
              <Clipboard className="mr-1.5 h-3.5 w-3.5" />
              Copy
            </Button>
          </div>

          <ValidationResult validation={validation} />
        </CardContent>
      </Card>
    </div>
  );
}

function ValidationResult({ validation }: { validation: WorkflowValidateResponse | null }) {
  if (!validation) return null;
  // The success shape has no `status` field at all (see WorkflowValidateSuccessSchema)
  // — only the error variant does, so `"error_type" in validation` is the
  // correct discriminant rather than `validation.status`.
  if ("error_type" in validation) {
    return <WorkflowsErrorState error={validation} />;
  }
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm" data-testid="validation-result">
      <div className={validation.valid ? "flex items-center gap-2 text-emerald-600 dark:text-emerald-400" : "flex items-center gap-2 text-rose-600 dark:text-rose-400"}>
        {validation.valid ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
        <span className="font-medium">{validation.valid ? "Valid" : "Invalid"}</span>
      </div>
      {validation.errors.length > 0 && (
        <ul className="list-inside list-disc text-xs text-rose-600 dark:text-rose-400">
          {validation.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {validation.warnings.length > 0 && (
        <ul className="list-inside list-disc text-xs text-amber-600 dark:text-amber-400">
          {validation.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {validation.errors.length === 0 && validation.warnings.length === 0 && (
        <p className="text-xs text-muted-foreground">No issues reported.</p>
      )}
    </div>
  );
}

export function WorkflowEditor() {
  const { name } = useParams<{ name?: string }>();
  const mode: "new" | "edit" = name ? "edit" : "new";
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();

  const existing = useQuery({
    queryKey: ["apex", "workflows", name, selectedCompanyId],
    queryFn: () => workflowsApi.show(name as string, selectedCompanyId),
    enabled: mode === "edit",
  });

  const validateMutation = useMutation({
    mutationFn: (yaml: string) => workflowsApi.validate(yaml),
  });

  const [initialDraft, setInitialDraft] = useState<WorkflowDraft | null>(mode === "new" ? emptyWorkflowDraft() : null);

  useEffect(() => {
    if (mode !== "edit" || initialDraft) return;
    if (existing.data && existing.data.status === "success") {
      setInitialDraft(draftFromWorkflowDetail(existing.data));
    }
  }, [existing.data, mode, initialDraft]);

  const backLink = (
    <Link to="/workflows" className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3 w-3" />
      Back to Workflows
    </Link>
  );

  if (mode === "edit" && existing.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workflow…</div>;
  }
  if (mode === "edit" && existing.data && existing.data.status === "error") {
    return (
      <div className="space-y-4 p-4">
        {backLink}
        <WorkflowsErrorState error={existing.data} />
      </div>
    );
  }
  if (!initialDraft) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workflow…</div>;
  }

  return (
    <WorkflowEditorForm
      mode={mode}
      initialDraft={initialDraft}
      onValidate={(yaml) => validateMutation.mutateAsync(yaml)}
      onBack={() => navigate("/workflows")}
    />
  );
}

