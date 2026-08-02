/**
 * COMPANY DATA ERASURE — destructive, owner-gated, previewed before it acts.
 *
 * The board accumulates data that has to be able to LEAVE it: a bad bulk
 * import, a tenant that offboards, an erasure obligation. Until now the product
 * could archive a project and delete a whole company, and nothing in between —
 * so a board with 27 wrongly-attributed initiatives and 129 wrongly-attributed
 * projects on it had no supported way back to empty, and the only remaining
 * option was hand-written SQL against a live database. That is the operation
 * this contract makes reviewable instead.
 *
 * Three properties, and the safety envelope IS the feature:
 *
 *   - **Dry run by default.** No `confirm` → the response is a per-table count
 *     of what WOULD go, and nothing is written. This is APEX's own
 *     constitutional rule (every production operation is previewed before it
 *     acts), and an erasure endpoint is the last place that should be a
 *     special case.
 *   - **Confirmation is a typed value, never a flag.** `confirm` must equal the
 *     company's own slug, matched server-side against the target. A stray
 *     `force=true` in a script, a replayed request, a wrong `:companyId` in a
 *     URL — none of them can empty a board, because none of them can guess the
 *     slug of the company they landed on.
 *   - **Consequences are stated before, not after.** A caller erasing 27
 *     initiatives sees "and 129 projects" in the preview. A count that only
 *     appears in the result is not a preview, it is a receipt.
 */
import { z } from "zod";

/**
 * What is being erased. Three scopes rather than three endpoints: the safety
 * envelope (owner gate, dry run, slug confirmation, audit record, one
 * transaction) is written once and cannot drift apart between them, which is
 * exactly the kind of drift that makes a destructive API unsafe over time.
 */
export const DATA_ERASURE_SCOPES = ["company", "projects", "initiatives"] as const;
export type DataErasureScope = (typeof DATA_ERASURE_SCOPES)[number];

/**
 * What happens to objects that hang off the erasure target.
 *
 *   - `block`   → refuse, and say what is in the way. Nothing is written.
 *   - `cascade` → take the children too, counted in the preview.
 *   - `detach`  → unlink the children and leave them on the board.
 *
 * There is no "guess" mode. The whole failure this exists to prevent is an
 * erasure that quietly took more than the caller pictured.
 */
export const DATA_ERASURE_CHILD_MODES = ["block", "cascade", "detach"] as const;
export type DataErasureChildMode = (typeof DATA_ERASURE_CHILD_MODES)[number];

/**
 * Per-scope default child handling. The defaults are NOT uniform, and that is
 * deliberate — they encode which relationship is a containment and which is a
 * reference:
 *
 *   - `initiatives` defaults to **block**. A project is not part of its
 *     initiative; it is attached to it. Erasing 27 initiatives and silently
 *     taking 129 projects would be the single worst outcome available here, so
 *     the default refuses and names them, and the caller opts into `cascade`
 *     after reading the count. This mirrors what the product already does at
 *     the company level, where a non-empty company answers 409 with counts
 *     instead of deleting.
 *   - `projects` defaults to **cascade**. An issue whose project is erased is
 *     unreachable board debris — the project IS an issue's home, so taking the
 *     issues with it is what the caller means. `detach` is available for the
 *     case where the issues genuinely should survive.
 *   - `company` has no child mode: everything company-scoped is the target.
 */
export const DATA_ERASURE_DEFAULT_CHILD_MODE: Record<DataErasureScope, DataErasureChildMode> = {
  company: "cascade",
  projects: "cascade",
  initiatives: "block",
};

export const companyDataErasureSchema = z.object({
  scope: z.enum(DATA_ERASURE_SCOPES),
  /** Omitted → the scope's documented default. Never inferred from the data. */
  children: z.enum(DATA_ERASURE_CHILD_MODES).optional(),
  /**
   * The company's OWN slug. Absent → dry run, writes nothing. Present and
   * matching → the erasure executes. Present and not matching → 422, because a
   * caller who cannot name the company they are pointing at has almost
   * certainly pointed at the wrong one.
   */
  confirm: z.string().min(1).max(200).optional(),
});

export type CompanyDataErasureRequest = z.infer<typeof companyDataErasureSchema>;

/** One table's share of the erasure. `rows` is real, counted, never estimated. */
export type DataErasureTableCount = {
  table: string;
  rows: number;
};

/**
 * A row that survives with a reference cleared rather than being deleted.
 * Kept separate from deletes in the report because they are different promises
 * to the reader: "this record is gone" and "this record lost a pointer".
 */
export type DataErasureDetachCount = {
  table: string;
  column: string;
  rows: number;
};

/** Why an erasure refused, with the counts that explain it. */
export type DataErasureBlock = {
  reason: string;
  /** The dependents standing in the way, per table. */
  counts: DataErasureTableCount[];
  /** The literal request body that would proceed instead. */
  resolution: string;
};

export type CompanyDataErasureReport = {
  scope: DataErasureScope;
  children: DataErasureChildMode;
  /** True → nothing was written and these are projections. */
  dryRun: boolean;
  companyId: string;
  companySlug: string | null;
  /** Non-null → nothing was written, whether or not this was a dry run. */
  blocked: DataErasureBlock | null;
  /** Tables losing rows, largest first. Zero-row tables are omitted. */
  deletes: DataErasureTableCount[];
  /** Rows kept, with a column cleared. */
  detaches: DataErasureDetachCount[];
  totalRowsDeleted: number;
  totalRowsDetached: number;
  /** Tables deliberately left alone, named so the reader need not infer it. */
  preserved: string[];
  /** The activity_log id of the audit record. Null on a dry run. */
  activityId: string | null;
};

/** The audit action written for an executed erasure. */
export const DATA_ERASURE_ACTIVITY_ACTION = "company.data_erased";
