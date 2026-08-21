import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Evaluation lessons — terminal nodes produced by evaluation runs.
 *
 * A lesson is an insight extracted from an eval run that informs future
 * work. Terminal node: lessons derive FROM eval runs but nothing derives
 * FROM lessons (they don't generate further lineage edges).
 *
 * APEX-146 cohesion invariant: each lesson must carry run_id (spine),
 * producer_* (provenance), and a lineage_edges row where to_id = lesson.id.
 */
export const evalLessons = pgTable(
  "eval_lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    producerKind: text("producer_kind"),
    producerId: uuid("producer_id"),
    producerVersion: text("producer_version"),
    lessonKind: text("lesson_kind").notNull().default("general"),
    summary: text("summary").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunIdx: index("eval_lessons_company_run_idx").on(table.companyId, table.runId),
    companyIssueIdx: index("eval_lessons_company_issue_idx").on(table.companyId, table.issueId),
    companyKindIdx: index("eval_lessons_company_kind_idx").on(table.companyId, table.lessonKind),
  }),
);
