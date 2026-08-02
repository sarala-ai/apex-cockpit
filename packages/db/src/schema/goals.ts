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
    hypothesis: text("hypothesis"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("goals_company_idx").on(table.companyId),
  }),
);
