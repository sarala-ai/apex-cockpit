// Parameter editor for one workflow-builder step. Two modes:
//
//  - schema-driven: when a JSON Schema for the (server_type, tool_name) pair
//    is available, render it via JsonSchemaForm, routing every string field
//    through ExpressionInput (fieldOverrides) so a value can be a literal or
//    a `${stepname.output}` reference into a preceding step.
//  - fallback: no schema route exists yet (see WorkflowEditor's
//    `getToolSchemaForStep` — GET /apex/workflows/toolcatalog is not built;
//    apex-core's platform_control resource server has no list-tools tool to
//    shell out to as of this session, verified against
//    apex/core/config/platform_control.yaml). Free-form key/value rows, each
//    value edited via ExpressionInput, are the only way to set parameters
//    until a catalog route lands.
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ExpressionInput, type ExpressionReference } from "./ExpressionInput";
import { JsonSchemaForm, type JsonSchemaFieldOverride, type JsonSchemaNode } from "./JsonSchemaForm";

export interface WorkflowStepParametersEditorProps {
  /** JSON Schema for this step's tool parameters, when known. Undefined
   *  today for every step — no tool catalog route exists yet — but the
   *  schema-driven path is fully wired for when one does. */
  schema?: JsonSchemaNode;
  parameters: Record<string, unknown>;
  onChange: (parameters: Record<string, unknown>) => void;
  /** Prior-step output references offered to ExpressionInput. */
  references: ExpressionReference[];
  disabled?: boolean;
}

export function WorkflowStepParametersEditor({
  schema,
  parameters,
  onChange,
  references,
  disabled,
}: WorkflowStepParametersEditorProps) {
  if (schema) {
    const fieldOverrides: JsonSchemaFieldOverride = (_path, fieldSchema, ctx) => {
      const type = Array.isArray(fieldSchema.type) ? fieldSchema.type[0] : fieldSchema.type;
      if (type !== "string" || fieldSchema.enum) return undefined;
      return (
        <ExpressionInput
          value={typeof ctx.value === "string" ? ctx.value : ""}
          onChange={ctx.onChange}
          references={references}
          disabled={ctx.disabled}
        />
      );
    };

    return (
      <JsonSchemaForm
        schema={schema}
        values={parameters}
        onChange={(values) => onChange(values)}
        disabled={disabled}
        fieldOverrides={fieldOverrides}
      />
    );
  }

  return (
    <ParameterKeyValueEditor
      parameters={parameters}
      onChange={onChange}
      references={references}
      disabled={disabled}
    />
  );
}

function ParameterKeyValueEditor({
  parameters,
  onChange,
  references,
  disabled,
}: {
  parameters: Record<string, unknown>;
  onChange: (parameters: Record<string, unknown>) => void;
  references: ExpressionReference[];
  disabled?: boolean;
}) {
  const entries = Object.entries(parameters);

  function updateKey(oldKey: string, newKey: string) {
    if (newKey === oldKey) return;
    const next: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  }

  function updateValue(key: string, value: string) {
    onChange({ ...parameters, [key]: value });
  }

  function removeKey(key: string) {
    const next = { ...parameters };
    delete next[key];
    onChange(next);
  }

  function addRow() {
    let candidate = "param";
    let i = 1;
    while (Object.prototype.hasOwnProperty.call(parameters, candidate)) {
      candidate = `param${i}`;
      i += 1;
    }
    onChange({ ...parameters, [candidate]: "" });
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        No tool schema available yet for this server/tool — TODO: wire to a tool catalog once one ships.
        Edit parameters as free-form key/value pairs.
      </p>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No parameters set.</p>
      ) : (
        <div className="space-y-2">
          {entries.map(([key, value]) => (
            <div key={key} className="flex items-start gap-2">
              <Input
                aria-label="Parameter name"
                value={key}
                disabled={disabled}
                onChange={(e) => updateKey(key, e.target.value)}
                className="w-40 shrink-0 font-mono text-xs"
              />
              <div className="flex-1">
                <ExpressionInput
                  aria-label={`Value for ${key}`}
                  value={typeof value === "string" ? value : String(value ?? "")}
                  onChange={(v) => updateValue(key, v)}
                  references={references}
                  disabled={disabled}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove parameter ${key}`}
                disabled={disabled}
                onClick={() => removeKey(key)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={addRow}>
        <Plus className="mr-1.5 h-4 w-4" />
        Add parameter
      </Button>
    </div>
  );
}
