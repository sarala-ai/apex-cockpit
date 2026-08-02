/**
 * THE REVIEW GRID — a scannable table of proposed records, correctable in
 * place, with provenance on every row.
 *
 * Why a grid and not a list of cards: the job is comparison. Reviewing 26
 * reconstructed initiatives means reading them against each other — which ones
 * are inferred, which have no stop condition, which two are really one — and
 * that comparison only exists when the rows share a column.
 *
 * Why provenance is a column and not a detail: the rows that need attention are
 * the inferred ones. A reviewer must be able to find them without opening
 * anything.
 *
 * This component knows NO kind. Columns and editability come from the resolved
 * renderer (or the server's declaration of the same kind), which is what makes
 * "add a kind, change nothing here" true.
 */
import { useState } from "react";
import type { ProposalColumn, ProposalRecord } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type ProposalGridProps = {
  columns: readonly ProposalColumn[];
  records: readonly ProposalRecord[];
  /** False once the gate has decided — the grid becomes a record of the review. */
  editable: boolean;
  onCorrect: (ref: string, patch: Record<string, unknown>) => void;
  /** Refs currently being saved, so a cell can say so rather than look inert. */
  savingRefs?: readonly string[];
  /** Per-ref advisory validation message returned by the last correction. */
  fieldErrors?: Record<string, string | null>;
};

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * One editable cell. Click to edit, save on blur — the interaction a
 * spreadsheet trains for, because that is what this replaces.
 */
function Cell({
  column,
  value,
  editable,
  onCommit,
}: {
  column: ProposalColumn;
  value: unknown;
  editable: boolean;
  onCommit: (next: string) => void;
}) {
  const text = toText(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);

  if (!editable) {
    return (
      <span className="text-sm text-muted-foreground whitespace-pre-wrap">{text || "—"}</span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="w-full text-left text-sm whitespace-pre-wrap hover:bg-accent/50 rounded px-1 py-0.5 min-h-6"
        aria-label={`Edit ${column.label}`}
        onClick={() => {
          setDraft(text);
          setEditing(true);
        }}
      >
        {text || <span className="text-muted-foreground">—</span>}
      </button>
    );
  }

  const commit = () => {
    setEditing(false);
    if (draft !== text) onCommit(draft);
  };

  if (column.options) {
    return (
      <select
        autoFocus
        aria-label={column.label}
        className="w-full rounded border bg-background text-sm px-1 py-0.5"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      >
        <option value="">—</option>
        {column.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (column.multiline) {
    return (
      <Textarea
        autoFocus
        aria-label={column.label}
        className="text-sm min-h-16"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    );
  }

  return (
    <Input
      autoFocus
      aria-label={column.label}
      className="text-sm h-7"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(text);
          setEditing(false);
        }
      }}
    />
  );
}

/**
 * Provenance, said plainly. `inferred` is the one that matters, so it is the
 * one that is visually loud; `confirmed` carries its source, because a citation
 * without a source is not a confirmation.
 */
function ProvenanceBadge({ record }: { record: ProposalRecord }) {
  const inferred = record.provenance.kind === "inferred";
  return (
    <span className="flex flex-col gap-0.5">
      <Badge variant={inferred ? "destructive" : "secondary"} className="w-fit">
        {record.provenance.kind}
      </Badge>
      {record.provenance.source ? (
        <span className="text-[11px] text-muted-foreground">{record.provenance.source}</span>
      ) : inferred ? (
        <span className="text-[11px] text-muted-foreground">no source — reconstructed</span>
      ) : null}
    </span>
  );
}

export function ProposalGrid({
  columns,
  records,
  editable,
  onCorrect,
  savingRefs = [],
  fieldErrors = {},
}: ProposalGridProps) {
  if (records.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="proposal-grid-empty">
        This proposal carries no records. There is nothing to review.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto border rounded-md">
      <table className="w-full text-sm" data-testid="proposal-grid">
        <thead className="bg-muted/50">
          <tr>
            <th className="text-left font-medium px-2 py-2 whitespace-nowrap">Provenance</th>
            <th className="text-left font-medium px-2 py-2 whitespace-nowrap">On approval</th>
            {columns.map((column) => (
              <th key={column.key} className="text-left font-medium px-2 py-2 whitespace-nowrap">
                {column.label}
                {!column.editable && (
                  <span className="ml-1 text-xs text-muted-foreground">(read-only)</span>
                )}
              </th>
            ))}
            <th className="text-left font-medium px-2 py-2 whitespace-nowrap">Reviewer note</th>
            <th className="px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const saving = savingRefs.includes(record.ref);
            const error = fieldErrors[record.ref];
            return (
              <tr
                key={record.ref}
                data-testid={`proposal-row-${record.ref}`}
                data-excluded={record.excluded ? "true" : "false"}
                className={cn(
                  "border-t align-top",
                  record.excluded && "opacity-50 line-through",
                )}
              >
                <td className="px-2 py-2">
                  <ProvenanceBadge record={record} />
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  {/* The single most consequential fact about a row: does
                      approving it create something new, or change something
                      that already exists on the board? */}
                  <Badge variant={record.targetId ? "outline" : "default"}>
                    {record.targetId ? "update" : "create"}
                  </Badge>
                </td>
                {columns.map((column) => (
                  <td key={column.key} className="px-2 py-2 max-w-80">
                    <Cell
                      column={column}
                      value={record.fields?.[column.key]}
                      editable={editable && column.editable}
                      onCommit={(next) =>
                        onCorrect(record.ref, { fields: { [column.key]: next || null } })
                      }
                    />
                  </td>
                ))}
                <td className="px-2 py-2 max-w-64">
                  <Cell
                    column={{ key: "note", label: "Reviewer note", editable: true, multiline: true }}
                    value={record.note}
                    editable={editable}
                    onCommit={(next) => onCorrect(record.ref, { note: next || null })}
                  />
                  {saving && <span className="text-xs text-muted-foreground">saving…</span>}
                  {error && <span className="text-xs text-destructive block">{error}</span>}
                </td>
                <td className="px-2 py-2 whitespace-nowrap">
                  {editable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCorrect(record.ref, { excluded: !record.excluded })}
                    >
                      {record.excluded ? "Restore" : "Drop"}
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
