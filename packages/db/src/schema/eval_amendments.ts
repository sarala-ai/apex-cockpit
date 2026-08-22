import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { evalLessons } from "./eval_lessons.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Evaluation amendments — terminal nodes that correct prior decisions.
 *
 * An amendment records a correction to an existing entity (identified by
 * subject_kind + subject_id). Terminal node: amendments amend other entities
 * but nothing amends an amendment.
 *
 * APEX-146 cohesion invariant: each amendment must carry run_id (spine),
 * producer_* (provenance), and a lineage_edges row where to_id = amendment.id.
 */
export const evalAmendments = pgTable(
  "eval_amendments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    producerKind: text("producer_kind"),
    producerId: uuid("producer_id"),
    producerVersion: text("producer_version"),
    lessonId: uuid("lesson_id").references(() => evalLessons.id, { onDelete: "set null" }),
    subjectKind: text("subject_kind").notNull(),
    subjectId: uuid("subject_id").notNull(),
    status: text("status").notNull().default("proposed"),
    summary: text("summary").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyRunIdx: index("eval_amendments_company_run_idx").on(table.companyId, table.runId),
    companyIssueIdx: index("eval_amendments_company_issue_idx").on(table.companyId, table.issueId),
    companyLessonIdx: index("eval_amendments_company_lesson_idx").on(table.companyId, table.lessonId),
    companySubjectIdx: index("eval_amendments_company_subject_idx").on(table.companyId, table.subjectKind, table.subjectId),
  }),
);
