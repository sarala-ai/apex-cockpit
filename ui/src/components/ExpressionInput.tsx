import { useState } from "react";
import { Code2, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

/**
 * A prior-step (or other well-known) value the reference picker can offer,
 * e.g. `{ label: "Build step → image tag", value: "${steps.build.image_tag}" }`.
 * The workflow builder feeds this with the current workflow's earlier steps'
 * outputs; `ExpressionInput` itself has no opinion on the expression syntax.
 */
export interface ExpressionReference {
  label: string;
  value: string;
}

export type ExpressionInputMode = "literal" | "reference";

/**
 * Heuristic for "this raw string looks like a reference expression" —
 * `${...}` end to end, same bracket convention the workflow DSL already uses
 * for `${step.output}` substitution. Used only to pick a sensible initial
 * mode; the stored value is always the raw string regardless of mode.
 */
const REFERENCE_LIKE_PATTERN = /^\$\{[^{}]+\}$/;

export function isReferenceLikeExpression(value: string): boolean {
  return REFERENCE_LIKE_PATTERN.test(value.trim());
}

export interface ExpressionInputProps {
  /** The raw string value — a literal, or a reference expression such as
   *  `${steps.build.image_tag}`. Stored as-is regardless of mode. */
  value: string;
  onChange: (value: string) => void;
  /** Prior-step outputs (or other named values) offered in reference mode. */
  references?: ExpressionReference[];
  /** Placeholder for literal mode's text input. */
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
}

export function ExpressionInput({
  value,
  onChange,
  references = [],
  placeholder,
  disabled,
  className,
  id,
  ...rest
}: ExpressionInputProps) {
  const [mode, setMode] = useState<ExpressionInputMode>(() =>
    isReferenceLikeExpression(value) ? "reference" : "literal",
  );

  const hasReferences = references.length > 0;
  const matchedReference = references.find((reference) => reference.value === value) ?? null;

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="inline-flex items-center rounded-md border border-border p-0.5" role="group" aria-label="Value type">
        <button
          type="button"
          aria-pressed={mode === "literal"}
          disabled={disabled}
          onClick={() => setMode("literal")}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors",
            mode === "literal"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Type className="h-3 w-3" />
          Literal
        </button>
        <button
          type="button"
          aria-pressed={mode === "reference"}
          disabled={disabled || !hasReferences}
          onClick={() => setMode("reference")}
          className={cn(
            "inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            mode === "reference"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Code2 className="h-3 w-3" />
          Reference
        </button>
      </div>

      {mode === "reference" ? (
        <select
          id={id}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
          value={matchedReference ? matchedReference.value : ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          {...rest}
        >
          <option value="">{hasReferences ? "Select a reference…" : "No references available"}</option>
          {!matchedReference && value ? (
            <option value={value}>Custom: {value}</option>
          ) : null}
          {references.map((reference) => (
            <option key={reference.value} value={reference.value}>
              {reference.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          {...rest}
        />
      )}
    </div>
  );
}
