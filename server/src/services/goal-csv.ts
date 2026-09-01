/**
 * The initiative review round-trip: export ~26 initiatives to a spreadsheet,
 * correct them there, import the corrections back.
 *
 * Why a spreadsheet at all. Correcting a reconstructed initiative tree is a
 * *scanning* job — the founder's corrections so far came from reading a list
 * side by side, not from opening 26 detail pages. A sheet puts every initiative
 * on one screen with its neighbours, which is the comparison the work actually
 * needs. The UI stays the place to do one careful edit; this is the place to do
 * twenty rough ones.
 *
 * Two rules carry the whole design:
 *
 *   1. **A blank cell means "leave this alone", never "clear this".** A human
 *      editing three cells in a 14-column sheet must not wipe the other eleven,
 *      and half the columns here (hypothesis, stop condition, description) are
 *      long prose nobody would retype to preserve. Clearing is therefore
 *      explicit: the literal token `--`.
 *   2. **Nothing is written without being shown first.** The import is dry-run
 *      by default and reports what WOULD change per row; `?apply=true` is a
 *      second, deliberate act. This matches the dry-run-first posture the rest
 *      of the platform takes with anything destructive.
 */

import {
  GOAL_CLOSURES,
  GOAL_PROVENANCE_KINDS,
  type Goal,
  type GoalClosure,
  type GoalProvenanceKind,
} from "@paperclipai/shared";
import type { GoalProjectSummary } from "./goals.js";

/**
 * The token that clears a field. Chosen over an empty cell because empty is the
 * overwhelmingly common state of a cell a human never touched, and over words
 * like NULL/none because those are plausible *values* for a budget or a stop
 * condition. `--` is not a sentence anyone writes by accident.
 */
export const CLEAR_TOKEN = "--";

/** Excel only reads UTF-8 CSV correctly when it starts with a byte-order mark. */
export const UTF8_BOM = "﻿";

type ColumnKey =
  | "id"
  | "title"
  | "provenance_kind"
  | "provenance_source"
  | "derived_status"
  | "closure"
  | "closure_reason"
  | "hypothesis"
  | "budget"
  | "stop_condition"
  | "projects"
  | "assumption_count"
  | "criteria_count"
  | "description";

/**
 * Column order is a reading order, left to right, for a human scanning rows:
 *
 *   identity (id, title) → how much to trust the row (provenance) → where it
 *   stands (derived_status, closure) → the judgement fields the review is
 *   actually for (hypothesis, budget, stop_condition) → evidence context
 *   (projects and the two counts) → the long prose last, because a wide
 *   description column pushes everything else off-screen.
 *
 * Read-only columns say so in the header. A header that lets a human discover
 * "my edit did nothing" only after importing is a trap; saying it in the cell
 * they are about to type into is the cheapest possible fix.
 */
const COLUMNS: ReadonlyArray<{ key: ColumnKey; header: string; readOnly?: boolean }> = [
  // The convention note lives on the first header because it is the first thing
  // read and it governs the whole sheet, not just this column.
  { key: "id", header: 'id (blank row = new initiative; blank cell = unchanged; "--" clears)' },
  { key: "title", header: "title" },
  { key: "provenance_kind", header: "provenance_kind (confirmed|inferred)" },
  { key: "provenance_source", header: "provenance_source" },
  {
    key: "derived_status",
    header: "derived_status (read-only — computed from projects; edits ignored)",
    readOnly: true,
  },
  { key: "closure", header: `closure (${GOAL_CLOSURES.join("|")})` },
  { key: "closure_reason", header: "closure_reason" },
  { key: "hypothesis", header: "hypothesis" },
  { key: "budget", header: "budget" },
  { key: "stop_condition", header: "stop_condition" },
  {
    key: "projects",
    header: "projects (read-only — name:status; name:status)",
    readOnly: true,
  },
  { key: "assumption_count", header: "assumption_count (read-only)", readOnly: true },
  { key: "criteria_count", header: "criteria_count (read-only)", readOnly: true },
  { key: "description", header: "description" },
];

export const GOAL_CSV_HEADERS = COLUMNS.map((column) => column.header);
export const GOAL_CSV_COLUMN_KEYS = COLUMNS.map((column) => column.key);
const READ_ONLY_KEYS = new Set<ColumnKey>(
  COLUMNS.filter((column) => column.readOnly).map((column) => column.key),
);

/**
 * Header text a human may have retyped, reformatted or truncated back to the
 * bare name. Everything after the first "(" is commentary for the reader, so it
 * is dropped before matching; case and surrounding space are ignored too.
 */
function normalizeHeader(header: string): string {
  return header.split("(")[0].trim().toLowerCase().replace(/\s+/g, "_");
}

// ─── CSV encoding ────────────────────────────────────────────────────────────

/**
 * RFC 4180 quoting. A field is quoted when it contains a delimiter, a quote or
 * any newline; embedded quotes are doubled. Initiative descriptions genuinely
 * contain commas and line breaks, so this is load-bearing, not defensive.
 */
export function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export function csvLine(values: readonly string[]): string {
  return values.map(csvEscape).join(",");
}

/**
 * RFC 4180 reader. Hand-written rather than pulled in as a dependency: the
 * grammar is a dozen lines, and the one behaviour we care most about — a quoted
 * field containing newlines — is exactly where thin wrappers around `split`
 * fail. CRLF and lone CR are normalised to LF inside quoted fields so a sheet
 * saved on Windows round-trips as the same text.
 */
export function parseCsv(input: string): string[][] {
  const text = input.startsWith(UTF8_BOM) ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  let fieldStarted = false;

  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      if (char === "\r") {
        // Normalise CRLF and lone CR inside a quoted field to a plain newline.
        field += "\n";
        index += text[index + 1] === "\n" ? 2 : 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      endField();
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      endRow();
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    fieldStarted = true;
    index += 1;
  }

  // A trailing newline ends the last row; anything else leaves a partial one.
  if (field.length > 0 || fieldStarted || quoted || row.length > 0) endRow();

  return rows;
}

// ─── Export ──────────────────────────────────────────────────────────────────

/** How projects are summarised into one cell. Read-only in v1 (see below). */
export function formatProjects(summaries: readonly GoalProjectSummary[]): string {
  return summaries.map((project) => `${project.name}:${project.status}`).join("; ");
}

export type ExportGoal = Goal & { derivedStatus?: string | null };

function cellFor(
  key: ColumnKey,
  goal: ExportGoal,
  projectSummaries: readonly GoalProjectSummary[],
): string {
  switch (key) {
    case "id":
      return goal.id;
    case "title":
      return goal.title ?? "";
    case "provenance_kind":
      return goal.provenance?.kind ?? "";
    case "provenance_source":
      return goal.provenance?.source ?? "";
    case "derived_status":
      return goal.derivedStatus ?? "";
    case "closure":
      return goal.closure ?? "";
    case "closure_reason":
      return goal.closureReason ?? "";
    case "hypothesis":
      return goal.hypothesis ?? "";
    case "budget":
      return goal.budget ?? "";
    case "stop_condition":
      return goal.stopCondition ?? "";
    case "projects":
      return formatProjects(projectSummaries);
    case "assumption_count":
      return String(goal.assumptions?.length ?? 0);
    case "criteria_count":
      return String(goal.validationCriteria?.length ?? 0);
    case "description":
      return goal.description ?? "";
  }
}

/**
 * The whole document, BOM included. Row order is the caller's; the route sorts
 * by `created_at` so two exports taken minutes apart diff to nothing.
 */
export function buildGoalCsv(
  goals: readonly ExportGoal[],
  projectsByGoal: ReadonlyMap<string, GoalProjectSummary[]>,
): string {
  const lines = [csvLine(GOAL_CSV_HEADERS)];
  for (const goal of goals) {
    const summaries = projectsByGoal.get(goal.id) ?? [];
    lines.push(csvLine(COLUMNS.map((column) => cellFor(column.key, goal, summaries))));
  }
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

/**
 * A PROPOSAL exported for offline scanning.
 *
 * This is what the CSV work became once proposals arrived: not the review path
 * (that is the grid, where corrections are addressable and provenance is
 * visible per row), but a way to take 26 rows somewhere else and read them —
 * on a plane, next to a spreadsheet of commit dates, wherever. Export only;
 * corrections come back through the proposal, not through a re-upload.
 *
 * Columns are driven by the kind's own declaration, so a new kind exports
 * correctly without touching this function.
 */
export function buildProposalCsv(
  records: ReadonlyArray<{
    ref: string;
    targetId?: string | null;
    provenance: { kind: string; source?: string | null };
    fields: Record<string, unknown>;
    note?: string | null;
    excluded?: boolean | null;
  }>,
  columns: ReadonlyArray<{ key: string; label: string }>,
): string {
  const headers = [
    "ref",
    "action (create|update — read-only)",
    "target_id (read-only)",
    "provenance_kind",
    "provenance_source",
    "excluded",
    ...columns.map((column) => column.label),
    "reviewer_note",
  ];
  const lines = [csvLine(headers)];
  for (const record of records) {
    lines.push(
      csvLine([
        record.ref,
        record.targetId ? "update" : "create",
        record.targetId ?? "",
        record.provenance.kind,
        record.provenance.source ?? "",
        record.excluded ? "yes" : "",
        ...columns.map((column) => {
          const value = record.fields[column.key];
          if (value === null || value === undefined) return "";
          return typeof value === "string" ? value : JSON.stringify(value);
        }),
        record.note ?? "",
      ]),
    );
  }
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

// ─── Import ──────────────────────────────────────────────────────────────────
//
// DEMOTED, deliberately. When this was built, importing a corrected sheet was
// the return leg of the only review path there was. It is now the SECONDARY
// path: the proposal grid is where a reconstruction gets reviewed, because it
// shows provenance per row, addresses corrections by ref, and gates the whole
// set once. What survives here is a legitimate bulk-edit tool for someone who
// already knows which twenty cells they want to change — kept, tested, and
// documented, but not presented in the UI as the way to review.

export type ImportChange = { field: string; from: string | null; to: string | null };

export type ImportRowResult = {
  /** 1-based line number in the file, header included — what Excel shows. */
  row: number;
  id: string | null;
  action: "create" | "update" | "unchanged" | "error";
  changes: ImportChange[];
  /** Things deliberately ignored: read-only columns that were edited. */
  notices: string[];
  error?: string;
};

export type ImportPlan = {
  applied: boolean;
  summary: {
    rows: number;
    created: number;
    updated: number;
    unchanged: number;
    errors: number;
    notices: number;
  };
  results: ImportRowResult[];
  /** Unknown columns and other whole-file observations. */
  notes: string[];
};

/** A parsed row: normalised header → raw cell text, plus its file line number. */
export type ParsedImportRow = { row: number; cells: Map<string, string> };

export type ParsedImportFile = {
  rows: ParsedImportRow[];
  notes: string[];
};

export function parseGoalCsv(input: string): ParsedImportFile {
  const grid = parseCsv(input);
  const notes: string[] = [];
  if (grid.length === 0) return { rows: [], notes: ["The file was empty."] };

  const headers = grid[0].map(normalizeHeader);
  const known = new Set<string>(GOAL_CSV_COLUMN_KEYS);
  const unknown = headers.filter((header) => header.length > 0 && !known.has(header));
  if (unknown.length > 0) {
    notes.push(`Ignored unrecognised column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  }
  if (!headers.includes("id")) {
    notes.push('No "id" column — every row will be treated as a new initiative.');
  }

  const rows: ParsedImportRow[] = [];
  for (let index = 1; index < grid.length; index += 1) {
    const values = grid[index];
    // A sheet exported from Excel often ends with one empty line. Dropping it
    // silently is right; reporting it as a malformed row is noise.
    if (values.every((value) => value.trim() === "")) continue;
    const cells = new Map<string, string>();
    headers.forEach((header, column) => {
      if (!known.has(header)) return;
      cells.set(header, values[column] ?? "");
    });
    rows.push({ row: index + 1, cells });
  }
  return { rows, notes };
}

/**
 * Blank → undefined (leave alone). `--` → null (clear). Anything else → the
 * trimmed text. This one function is the whole blank-vs-clear contract.
 */
export function readCell(cells: ReadonlyMap<string, string>, key: string): string | null | undefined {
  const raw = cells.get(key);
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;
  if (value === CLEAR_TOKEN) return null;
  return value;
}

/** The subset of a goal an import may write. */
export type InitiativePatch = {
  title?: string;
  description?: string | null;
  closure?: GoalClosure | null;
  closureReason?: string | null;
  hypothesis?: string | null;
  budget?: string | null;
  stopCondition?: string | null;
  provenance?: { kind: GoalProvenanceKind; source?: string | null } | null;
};

export type ExistingInitiative = Pick<
  ExportGoal,
  | "id"
  | "title"
  | "description"
  | "closure"
  | "closureReason"
  | "hypothesis"
  | "budget"
  | "stopCondition"
  | "provenance"
  | "derivedStatus"
  | "assumptions"
  | "validationCriteria"
>;

const TEXT_FIELDS = [
  { cell: "title", field: "title" },
  { cell: "closure_reason", field: "closureReason" },
  { cell: "hypothesis", field: "hypothesis" },
  { cell: "budget", field: "budget" },
  // Present but never defaulted: a stop condition may be set by a human here
  // and must never be invented on their behalf. "Never retro-fit stop
  // conditions" (docs/architecture/product-engineering.md).
  { cell: "stop_condition", field: "stopCondition" },
  { cell: "description", field: "description" },
] as const;

/**
 * Read-only columns are compared, not applied. A human who edited one gets told
 * their edit was ignored rather than watching it vanish — and the comparison
 * doubles as a drift check on `derived_status`, which is precisely the column
 * most likely to look wrong to someone reading old data.
 */
function readOnlyNotices(
  cells: ReadonlyMap<string, string>,
  existing: ExistingInitiative | null,
  projectsCell: string | null,
): string[] {
  const notices: string[] = [];
  const compare = (key: ColumnKey, actual: string, label: string) => {
    if (!READ_ONLY_KEYS.has(key)) return;
    const raw = cells.get(key);
    if (raw === undefined) return;
    const given = raw.trim();
    if (given === "" || given === actual.trim()) return;
    notices.push(`${label} is computed, not stored — "${given}" ignored (actual: "${actual}").`);
  };

  compare("derived_status", existing?.derivedStatus ?? "", "derived_status");
  if (projectsCell !== null) compare("projects", projectsCell, "projects");
  compare("assumption_count", String(existing?.assumptions?.length ?? 0), "assumption_count");
  compare("criteria_count", String(existing?.validationCriteria?.length ?? 0), "criteria_count");
  return notices;
}

function describe(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Turn one parsed row into a patch plus the diff a human will read, or into a
 * row-level error. Errors are values, never throws: one bad row must not cost
 * the other twenty-five their import.
 */
export function planRow(
  parsed: ParsedImportRow,
  existing: ExistingInitiative | null,
  projectsCell: string | null,
): { result: ImportRowResult; patch?: InitiativePatch } {
  const { cells, row } = parsed;
  const idCell = (cells.get("id") ?? "").trim();
  const notices = readOnlyNotices(cells, existing, projectsCell);
  const fail = (error: string): { result: ImportRowResult } => ({
    result: { row, id: idCell || null, action: "error", changes: [], notices, error },
  });

  if (idCell && !existing) {
    return fail(`No initiative with id ${idCell} in this company.`);
  }

  const patch: InitiativePatch = {};
  const changes: ImportChange[] = [];
  const record = (field: string, from: unknown, to: unknown) => {
    const before = describe(from);
    const after = describe(to);
    if (before === after) return false;
    changes.push({ field, from: before, to: after });
    return true;
  };

  for (const { cell, field } of TEXT_FIELDS) {
    const value = readCell(cells, cell);
    if (value === undefined) continue;
    if (field === "title" && value === null) {
      return fail('title cannot be cleared — an initiative without a title is not a record.');
    }
    const current = existing ? (existing as Record<string, unknown>)[field] ?? null : null;
    if (record(field, current, value)) {
      (patch as Record<string, unknown>)[field] = value;
    }
  }

  const closure = readCell(cells, "closure");
  if (closure !== undefined) {
    if (closure !== null && !(GOAL_CLOSURES as readonly string[]).includes(closure)) {
      return fail(`closure must be one of ${GOAL_CLOSURES.join(", ")} (got "${closure}").`);
    }
    if (record("closure", existing?.closure ?? null, closure)) {
      patch.closure = closure as GoalClosure | null;
    }
  }

  // Two cells, one stored object. Editing only the source must not silently
  // drop the kind, so the object is rebuilt from whichever half is unchanged.
  const provenanceKind = readCell(cells, "provenance_kind");
  const provenanceSource = readCell(cells, "provenance_source");
  if (provenanceKind !== undefined || provenanceSource !== undefined) {
    const current = existing?.provenance ?? null;
    let next: InitiativePatch["provenance"];
    if (provenanceKind === null) {
      // Clearing the kind clears the whole record: a source with no kind is a
      // citation with nothing to weight it against.
      next = null;
    } else {
      const kind = provenanceKind ?? current?.kind;
      if (!kind) {
        return fail("provenance_kind is required when setting provenance_source.");
      }
      if (!(GOAL_PROVENANCE_KINDS as readonly string[]).includes(kind)) {
        return fail(
          `provenance_kind must be one of ${GOAL_PROVENANCE_KINDS.join(", ")} (got "${kind}").`,
        );
      }
      const source =
        provenanceSource === undefined
          ? current?.source ?? null
          : provenanceSource === null
            ? null
            : provenanceSource;
      next = { kind: kind as GoalProvenanceKind, source };
    }
    if (record("provenance", current, next)) patch.provenance = next;
  }

  if (!existing) {
    if (!patch.title) {
      return fail("title is required to create an initiative.");
    }
    return {
      result: { row, id: null, action: "create", changes, notices },
      patch,
    };
  }

  if (changes.length === 0) {
    return { result: { row, id: existing.id, action: "unchanged", changes: [], notices } };
  }
  return { result: { row, id: existing.id, action: "update", changes, notices }, patch };
}

export function summarise(results: readonly ImportRowResult[], applied: boolean): ImportPlan["summary"] & { applied: boolean } {
  return {
    applied,
    rows: results.length,
    created: results.filter((result) => result.action === "create").length,
    updated: results.filter((result) => result.action === "update").length,
    unchanged: results.filter((result) => result.action === "unchanged").length,
    errors: results.filter((result) => result.action === "error").length,
    notices: results.reduce((total, result) => total + result.notices.length, 0),
  };
}

/**
 * Said out loud in every response, because "it silently did nothing" is the
 * failure mode a read-only column invites.
 */
export const IMPORT_NOTES = {
  projectsReadOnly:
    "The projects column is read-only in v1: it is a summary for reading, and changes to it are reported as notices, never applied. Creating or re-statusing projects from this sheet is a separate feature.",
  derivedStatusReadOnly:
    "derived_status is computed from an initiative's projects and can never be set here; a cell that disagrees with reality is reported as a notice, not an error.",
  blankVsClear: `A blank cell leaves the stored value unchanged. To clear a field, put ${CLEAR_TOKEN} in it.`,
} as const;
