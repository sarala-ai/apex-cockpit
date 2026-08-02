import { z } from "zod";
import {
  GOAL_ASSUMPTION_STATUSES,
  GOAL_ASSUMPTION_TYPES,
  GOAL_CLOSURES,
  GOAL_CRITERION_STATUSES,
  GOAL_CRITERION_VERDICTS,
  GOAL_LEVELS,
  GOAL_PROVENANCE_KINDS,
  GOAL_STATUSES,
} from "../constants.js";

/**
 * One assumption an initiative rests on. Stored as a jsonb array on the goal
 * rather than a child table: the list is always read and written as a unit
 * (it is the initiative's risk sheet, never queried across initiatives), it
 * has no independent lifecycle, identity or foreign keys, and nothing joins to
 * a single assumption. The typed-column doctrine applies to fields that get
 * filtered, indexed or joined; a per-record list read whole is exactly the
 * case jsonb is for. The Zod schema below — enforced on every write — is what
 * keeps the payload typed despite the untyped column.
 */
export const goalAssumptionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  type: z.enum(GOAL_ASSUMPTION_TYPES),
  status: z.enum(GOAL_ASSUMPTION_STATUSES),
  evidence: z.string().optional().nullable(),
});

export type GoalAssumption = z.infer<typeof goalAssumptionSchema>;

/** An ISO date (`2026-08-02`) or full ISO timestamp. Stored as text in jsonb. */
const isoDateString = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)), {
    message: "must be an ISO date (2026-08-02) or ISO timestamp",
  });

/**
 * One pre-registered validation criterion. Same storage choice as the
 * assumption sheet above — a jsonb array on the goal, shape enforced by this
 * schema on every write — and for the same reasons: criteria are read and
 * written as a set, nothing joins to a single criterion, none outlives its
 * initiative, and the only cross-initiative query the platform performs (the
 * review sweep) scans initiatives anyway because it must read every criterion
 * on each one to decide. A child table would buy a `WHERE review_date <= now`
 * index and cost a second lifecycle to keep consistent with the goal it
 * describes; at ~26 initiatives that trade is not close.
 *
 * `measure` and `threshold` are free text on purpose. A metric DSL would
 * promise a comparison the platform cannot honestly perform — "≥80% tool-call
 * ratio" needs a person to look at a number and say whether it counts, and
 * pretending otherwise re-creates the unread criterion in a new form. `window`
 * is likewise free text: it describes the measurement period for a reader,
 * while `reviewDate` is the single machine-read field, the one the sweep
 * compares against the clock. Two date-ish fields with one job each beats one
 * field doing both jobs badly.
 *
 * OWNER AND DATE ARE THE DISCIPLINE. A criterion without a named reader and a
 * date "is a wish with a number in it"
 * (docs/architecture/initiative-discipline.md §3), so both are required — and
 * the rejection at write time is the whole point of this object existing.
 * The single exemption is `never_registered`, where the honest record is that
 * nobody named a reader and nobody set a date; there, both must be ABSENT,
 * because supplying them would retro-fit a decision that was never made
 * (product-engineering.md, "Never retro-fit stop conditions").
 */
export const goalValidationCriterionSchema = z
  .object({
    id: z.string().min(1),
    /** What must be true. */
    statement: z.string().min(1),
    /** What is observed. Free text — deliberately not a metric expression. */
    measure: z.string().optional().nullable(),
    /** The bar, e.g. "≥80%". Free text; the comparison is a human judgement. */
    threshold: z.string().optional().nullable(),
    /** When it is measured, for a reader. Free text; `reviewDate` drives the sweep. */
    window: z.string().optional().nullable(),
    /** The named reader — a person… */
    ownerUserId: z.string().min(1).optional().nullable(),
    /** …or an agent. At least one is required. */
    ownerAgentId: z.string().uuid().optional().nullable(),
    /** When someone looks. Required; the sweep surfaces the criterion on it. */
    reviewDate: isoDateString.optional().nullable(),
    status: z.enum(GOAL_CRITERION_STATUSES),
    /** Stamped by the report API when a verdict is recorded. */
    reviewedAt: isoDateString.optional().nullable(),
    reviewNote: z.string().optional().nullable(),
    /**
     * Stamped by the review sweep the first time this criterion is surfaced to
     * its owner. This is what makes the sweep idempotent: a due criterion
     * reaches its reader once, not once per tick.
     */
    surfacedAt: isoDateString.optional().nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "never_registered") {
      // The honest import. Asserting a reader or a date here would be
      // fabrication — the exact failure mode the onboarding doctrine names.
      for (const field of ["ownerUserId", "ownerAgentId", "reviewDate"] as const) {
        if (value[field] === undefined || value[field] === null) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} cannot be set on a criterion with status "never_registered" — nobody registered one, and recording one now would be a retro-fit`,
        });
      }
      return;
    }
    if (!value.ownerUserId && !value.ownerAgentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownerUserId"],
        message:
          "a validation criterion needs a named reader: set ownerUserId or ownerAgentId",
      });
    }
    if (!value.reviewDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reviewDate"],
        message: "a validation criterion needs a reviewDate: who looks, and when",
      });
    }
  });

export type GoalValidationCriterion = z.infer<typeof goalValidationCriterionSchema>;

/**
 * How this initiative's record came to exist. Structured rather than a
 * sentence in the description, because an agent citing the row six months
 * later has to be able to weight it — inferred history is a question about the
 * past, confirmed history is prior art — and prose cannot be weighted.
 */
export const goalProvenanceSchema = z.object({
  kind: z.enum(GOAL_PROVENANCE_KINDS),
  /** Where it came from: "47 commits, March–May", a design doc, a person. */
  source: z.string().optional().nullable(),
});

export type GoalProvenance = z.infer<typeof goalProvenanceSchema>;

/** Recording a verdict against a criterion — the read-back this all exists for. */
export const reportCriterionSchema = z.object({
  status: z.enum(GOAL_CRITERION_VERDICTS),
  reviewNote: z.string().optional().nullable(),
});

export type ReportCriterion = z.infer<typeof reportCriterionSchema>;

/** Fields that only carry meaning on an initiative. */
export const GOAL_INITIATIVE_FIELDS = [
  "closure",
  "closureReason",
  "assumptions",
  "budget",
  "stopCondition",
  "hypothesis",
  "validationCriteria",
  "provenance",
] as const;

export const goalBaseSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  level: z.enum(GOAL_LEVELS).optional().default("task"),
  status: z.enum(GOAL_STATUSES).optional().default("planned"),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
  // Initiative-only fields. Nullable everywhere; meaningful only when
  // level === "initiative".
  closure: z.enum(GOAL_CLOSURES).optional().nullable(),
  closureReason: z.string().optional().nullable(),
  assumptions: z.array(goalAssumptionSchema).optional().nullable(),
  budget: z.string().optional().nullable(),
  stopCondition: z.string().optional().nullable(),
  hypothesis: z.string().optional().nullable(),
  // Named `validationCriteria`, not `criteria`: tasks and tickets in this
  // codebase already carry *acceptance* criteria, and a bare `criteria` beside
  // them would read as the same thing. These are the pre-registered bars an
  // initiative is judged against, which is a different claim.
  validationCriteria: z.array(goalValidationCriterionSchema).optional().nullable(),
  provenance: goalProvenanceSchema.optional().nullable(),
});

/**
 * An initiative field set on a goal that is not an initiative is a modelling
 * error, not a harmless extra: a "stop condition" on a team goal reads as a
 * commitment nobody made. Rejected at create time, where the level is known.
 * PATCH cannot see the level in isolation, so the equivalent check lives in
 * the route, against the stored row.
 */
export const createGoalSchema = goalBaseSchema.superRefine((value, ctx) => {
  if (value.level === "initiative") return;
  for (const field of GOAL_INITIATIVE_FIELDS) {
    if (value[field] === undefined || value[field] === null) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [field],
      message: `${field} is only valid on a goal with level "initiative"`,
    });
  }
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = goalBaseSchema.partial();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;

/**
 * Which initiative-only fields a PATCH is trying to set, given the level the
 * goal will have after the patch. Empty array = the update is consistent.
 */
export function initiativeFieldsRejectedFor(
  level: string,
  patch: Record<string, unknown>,
): string[] {
  if (level === "initiative") return [];
  return GOAL_INITIATIVE_FIELDS.filter(
    (field) => patch[field] !== undefined && patch[field] !== null,
  );
}
