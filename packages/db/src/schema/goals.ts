import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

/**
 * One assumption an initiative rests on. Mirrors `goalAssumptionSchema` in
 * @paperclipai/shared, which is what actually validates writes.
 */
export type GoalAssumptionRecord = {
  id: string;
  statement: string;
  type: "technical" | "regulatory" | "commercial" | "operational";
  status: "untested" | "retired" | "blocked";
  evidence?: string | null;
};

/**
 * One pre-registered validation criterion. Mirrors
 * `goalValidationCriterionSchema` in @paperclipai/shared, which is what
 * actually validates writes (owner and reviewDate required; both forbidden on
 * `never_registered`).
 */
export type GoalValidationCriterionRecord = {
  id: string;
  statement: string;
  measure?: string | null;
  threshold?: string | null;
  window?: string | null;
  ownerUserId?: string | null;
  ownerAgentId?: string | null;
  reviewDate?: string | null;
  status: "pending" | "hit" | "missed" | "never_registered";
  reviewedAt?: string | null;
  reviewNote?: string | null;
  surfacedAt?: string | null;
};

/**
 * One hypothesis under test. Mirrors `goalHypothesisSchema` in
 * @paperclipai/shared, which is what actually validates writes (any verdict
 * other than `untested` requires evidence and a testedAt date).
 */
export type GoalHypothesisRecord = {
  id: string;
  statement: string;
  verdict: "untested" | "supported" | "falsified" | "inconclusive";
  evidence?: string | null;
  testedAt?: string | null;
};

/**
 * A decided pause. Mirrors `goalHoldSchema`; presence is the assertion, so the
 * reason cannot go missing.
 */
export type GoalHoldRecord = {
  reason: string;
  since: string;
  byUserId?: string | null;
  byAgentId?: string | null;
  reviewDate?: string | null;
};

/** How an initiative's record came to exist. Mirrors `goalProvenanceSchema`. */
export type GoalProvenanceRecord = {
  kind: "confirmed" | "inferred";
  source?: string | null;
};

export const goals = pgTable(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    title: text("title").notNull(),
    description: text("description"),
    level: text("level").notNull().default("task"),
    status: text("status").notNull().default("planned"),
    parentId: uuid("parent_id").references((): AnyPgColumn => goals.id),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id),
    // ── Initiative-only columns ────────────────────────────────────────────
    // All nullable, none backfilled. Every existing row predates the
    // initiative level; null means "not an initiative, or not written down"
    // and renders as absent rather than as a guessed default.
    //
    // `closure` is separate from `status` on purpose: the four initiative
    // closures (validated/stopped/revised/expired) are verdicts about what was
    // learned, while `status` stays the lifecycle state every goal level
    // already uses. Overloading achieved/cancelled would change what those
    // words mean for company/team/agent/task goals.
    closure: text("closure"),
    closureReason: text("closure_reason"),
    // jsonb rather than a child table: the risk sheet is read and written whole,
    // never joined or filtered across initiatives, and no assumption has an
    // identity outside its initiative. Shape is enforced by Zod on every write.
    assumptions: jsonb("assumptions").$type<GoalAssumptionRecord[]>(),
    // Free text on purpose — "two weeks" and "₹40k" are both budgets and unit
    // modelling here would buy nothing a reader does not already understand.
    budget: text("budget"),
    stopCondition: text("stop_condition"),
    // The original one-field hypothesis. KEPT, and not migrated: three of the
    // ten populated fields hold two or three questions in one string with
    // their verdicts written as prose, so any automatic split would invent
    // sentence boundaries and any default verdict would erase a recorded
    // answer. It stays readable until a person restates each question into
    // `hypotheses` below.
    hypothesis: text("hypothesis"),
    // The answerable form: a list, exactly like `assumptions` and
    // `validation_criteria`, read and written whole, no member outliving its
    // initiative, shape enforced by Zod on every write. A verdict of
    // supported/falsified/inconclusive is queryable here; in the text column
    // above it was a sentence nothing could read back.
    hypotheses: jsonb("hypotheses").$type<GoalHypothesisRecord[]>(),
    // A decided pause, which overrides the derived status. Derived state stays
    // computed; a decision stays decided — the same split `closure` already
    // makes for how an initiative ended. One nullable object rather than a
    // reason column and a date column, so a hold without a reason cannot be
    // represented at all.
    hold: jsonb("hold").$type<GoalHoldRecord>(),
    // The pre-registered bars, same jsonb reasoning as `assumptions`: read and
    // written as a set, no criterion has identity or lifetime outside its
    // initiative, and the one cross-initiative reader (the review sweep) has to
    // open every initiative's list anyway. `stop_condition` above stays as the
    // prose summary; these are the things that can actually be marked hit or
    // missed by a named reader on a date.
    validationCriteria: jsonb("validation_criteria").$type<GoalValidationCriterionRecord[]>(),
    // Confirmed vs inferred, structured. It lived in description prose, where
    // an agent citing the row later could not weight it.
    provenance: jsonb("provenance").$type<GoalProvenanceRecord>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("goals_company_idx").on(table.companyId),
  }),
);
