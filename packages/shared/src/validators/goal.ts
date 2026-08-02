import { z } from "zod";
import {
  GOAL_ASSUMPTION_STATUSES,
  GOAL_ASSUMPTION_TYPES,
  GOAL_CLOSURES,
  GOAL_LEVELS,
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

/** Fields that only carry meaning on an initiative. */
export const GOAL_INITIATIVE_FIELDS = [
  "closure",
  "closureReason",
  "assumptions",
  "budget",
  "stopCondition",
  "hypothesis",
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
