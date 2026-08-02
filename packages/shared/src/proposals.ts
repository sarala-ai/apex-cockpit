/**
 * PROPOSALS — the missing reviewable artifact.
 *
 * A design file is reviewable: it renders at a gate and a person approves it.
 * A code change is reviewable: a diff renders at a gate. An infrastructure
 * plan-diff is reviewable: proposed records render as a table, one gate
 * approves, the records materialise. **Structured objects were not reviewable
 * at all** — which is exactly why reviewing 26 reconstructed initiatives had no
 * home in the product and a spreadsheet looked like the answer.
 *
 * A proposal fixes that with three properties and no more:
 *
 *   - **Typed records under a `kind`.** The kind decides the record shape, the
 *     rendered columns, which cells a reviewer may edit, and what
 *     materialisation does. Adding a kind must never touch the review surface.
 *   - **Per-record provenance.** `confirmed` with a source is prior art;
 *     `inferred` is a reconstruction. A reviewer scanning 26 rows has to see
 *     which is which without opening anything, because the rows that need
 *     their attention are the inferred ones.
 *   - **Corrections live on the proposal, not on live objects.** Nothing exists
 *     on the board until the single gate approves. That is what makes review
 *     safe to do roughly and fast: a wrong correction costs nothing until the
 *     approval, and rejection returns the whole set to the proposing agent with
 *     the reasons attached.
 *
 * The kind registry below is the seam, deliberately mirroring the
 * artifact-renderer registry the gate surface already uses: a kind registers
 * its record schema and its materialiser, and neither the proposal routes nor
 * the review UI learn its name.
 */
import { z } from "zod";
import { GOAL_CLOSURES } from "./constants.js";
import { goalProvenanceSchema } from "./validators/goal.js";

/**
 * One kind ships in v1. One kind is enough to prove a registry — the same way
 * a single fake kind proved the artifact-renderer resolver — and a second kind
 * built before the first has a real reviewer is a guess about a shape nobody
 * has scanned yet.
 */
export const PROPOSAL_KINDS = ["initiatives"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * `draft` → the proposing agent is still assembling. `in_review` → at the gate.
 * The three terminal states mirror the gate's own decisions, so a proposal
 * never disagrees with its approval about what happened.
 */
export const PROPOSAL_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "changes_requested",
  "rejected",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** The approval type a submitted proposal opens. One proposal, one gate. */
export const PROPOSAL_APPROVAL_TYPE = "proposal_review";

/**
 * One proposed record.
 *
 * `targetId` is what makes this usable against a board that already has
 * objects on it: present → materialisation UPDATES that object, absent →
 * it CREATES one. A proposal that could only create would be unusable for the
 * exact job it was built for, since a reconstruction is mostly corrections to
 * initiatives that already exist.
 */
export const proposalRecordSchema = z.object({
  /** Stable within the proposal; how a correction addresses a row. */
  ref: z.string().min(1).max(128),
  /** Present → update this object on approval. Absent → create a new one. */
  targetId: z.string().uuid().optional().nullable(),
  /**
   * Required, not optional. A reconstructed record whose provenance is unstated
   * reads as recorded fact, which is the single failure this whole model exists
   * to prevent ("never present reconstructed intent as recorded intent").
   */
  provenance: goalProvenanceSchema,
  /** Kind-shaped. Validated against the kind's schema, not here. */
  fields: z.record(z.string(), z.unknown()),
  /**
   * The reviewer's note for this row. One note per row, not a comment thread:
   * per-row is enough to say "this is wrong because X" while scanning, and a
   * thread per cell is a different feature with a different reader.
   */
  note: z.string().max(4000).optional().nullable(),
  /**
   * The reviewer struck this row out. It stays visible (a dropped row is
   * evidence about the reconstruction) but materialises nothing.
   */
  excluded: z.boolean().optional().nullable(),
  correctedAt: z.string().optional().nullable(),
  correctedByUserId: z.string().optional().nullable(),
});

export type ProposalRecord = z.infer<typeof proposalRecordSchema>;

export const createProposalSchema = z.object({
  kind: z.enum(PROPOSAL_KINDS),
  title: z.string().min(1).max(300),
  summary: z.string().max(4000).optional().nullable(),
  proposedByAgentId: z.string().uuid().optional().nullable(),
  records: z.array(proposalRecordSchema).max(500).default([]),
});

export type CreateProposal = z.infer<typeof createProposalSchema>;

export const updateProposalSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  summary: z.string().max(4000).optional().nullable(),
  records: z.array(proposalRecordSchema).max(500).optional(),
});

export type UpdateProposal = z.infer<typeof updateProposalSchema>;

/**
 * A correction to one row. Every part is optional because the three things a
 * reviewer does — fix a cell, leave a note, strike the row out — are
 * independent, and a PATCH that demanded all three would make the cheap ones
 * expensive.
 *
 * `fields` MERGES into the record's fields: a reviewer fixing one cell must not
 * have to resend the other nine. Same blank-means-unchanged instinct the CSV
 * import carries, in a shape where it can be expressed properly.
 */
export const correctProposalRecordSchema = z.object({
  fields: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(4000).optional().nullable(),
  excluded: z.boolean().optional(),
  provenance: goalProvenanceSchema.optional().nullable(),
});

export type CorrectProposalRecord = z.infer<typeof correctProposalRecordSchema>;

export const submitProposalSchema = z.object({
  /** Optional context for the reviewer, carried onto the approval payload. */
  note: z.string().max(4000).optional().nullable(),
});

export type SubmitProposal = z.infer<typeof submitProposalSchema>;

// ─── The `initiatives` kind ──────────────────────────────────────────────────

/**
 * The initiative fields a proposal may carry. Deliberately NOT the whole goal:
 * `status` is derived from projects and can never be proposed, `assumptions`
 * and `validationCriteria` are sub-objects with their own review shape, and
 * `level` is implied by the kind. What is left is exactly the set a reviewer
 * scans and corrects.
 *
 * `stopCondition` may be proposed but is never defaulted — an empty stop
 * condition is an honest record that nobody wrote one, and filling it in at
 * materialisation would be the retro-fit the discipline doc forbids.
 */
export const initiativeProposalFieldsSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20000).optional().nullable(),
  hypothesis: z.string().max(4000).optional().nullable(),
  budget: z.string().max(300).optional().nullable(),
  stopCondition: z.string().max(4000).optional().nullable(),
  closure: z.enum(GOAL_CLOSURES).optional().nullable(),
  closureReason: z.string().max(4000).optional().nullable(),
});

export type InitiativeProposalFields = z.infer<typeof initiativeProposalFieldsSchema>;

/** One column as the review grid should render it. */
export type ProposalColumn = {
  key: string;
  label: string;
  /** False → shown but not correctable (computed or identity columns). */
  editable: boolean;
  /** Long prose gets a textarea and a wider cell. */
  multiline?: boolean;
  /** A fixed vocabulary renders as a select, not a free-text box. */
  options?: readonly string[];
};

/**
 * A registered kind. `fieldsSchema` validates what materialisation will write;
 * `columns` drives the grid. Registering these together is what makes "add a
 * kind, change nothing else" true — the server validates and the UI renders
 * from the same declaration.
 */
export type ProposalKindDefinition = {
  kind: string;
  /** What one record is, in a reviewer's words. Used as the grid's caption. */
  label: string;
  fieldsSchema: z.ZodTypeAny;
  columns: readonly ProposalColumn[];
};

const INITIATIVE_COLUMNS: readonly ProposalColumn[] = [
  { key: "title", label: "Title", editable: true },
  { key: "hypothesis", label: "Hypothesis", editable: true, multiline: true },
  { key: "budget", label: "Budget", editable: true },
  { key: "stopCondition", label: "Stop condition", editable: true, multiline: true },
  { key: "closure", label: "Closure", editable: true, options: GOAL_CLOSURES },
  { key: "closureReason", label: "Closure reason", editable: true, multiline: true },
  { key: "description", label: "Description", editable: true, multiline: true },
];

const definitions = new Map<string, ProposalKindDefinition>();

export function registerProposalKind(definition: ProposalKindDefinition): void {
  definitions.set(definition.kind, definition);
}

export function getProposalKind(kind: string): ProposalKindDefinition | null {
  return definitions.get(kind) ?? null;
}

export function listProposalKinds(): ProposalKindDefinition[] {
  return [...definitions.values()];
}

registerProposalKind({
  kind: "initiatives",
  label: "Initiative",
  fieldsSchema: initiativeProposalFieldsSchema,
  columns: INITIATIVE_COLUMNS,
});

/**
 * Validate one record's fields against its kind. Returns an error string rather
 * than throwing: a proposal with one bad row must still be reviewable, and the
 * bad row must say what is wrong with it in the grid.
 */
export function validateProposalRecordFields(
  kind: string,
  fields: Record<string, unknown>,
): string | null {
  const definition = getProposalKind(kind);
  if (!definition) return `Unknown proposal kind "${kind}".`;
  const parsed = definition.fieldsSchema.safeParse(fields);
  if (parsed.success) return null;
  return parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "fields"}: ${issue.message}`)
    .join("; ");
}

export interface Proposal {
  id: string;
  companyId: string;
  kind: ProposalKind | string;
  title: string;
  summary: string | null;
  status: ProposalStatus;
  records: ProposalRecord[];
  proposedByAgentId: string | null;
  proposedByUserId: string | null;
  approvalId: string | null;
  materializedAt: string | Date | null;
  materialization: {
    created: string[];
    updated: string[];
    skipped: string[];
    errors: Array<{ ref: string; error: string }>;
  } | null;
  createdAt: string | Date;
  updatedAt: string | Date;
}

/** A proposal is only correctable before a decision lands. */
export function isProposalEditable(status: string): boolean {
  return status === "draft" || status === "in_review" || status === "changes_requested";
}
