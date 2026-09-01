import { index, pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { releases } from "./releases.js";

/**
 * The join where the two axes meet. A change belongs to ONE initiative path
 * (via `issues.goal_id`) and ONE release per environment — so the initiative a
 * change serves is NOT denormalised here. It is read through the issue, which
 * is the single writer of that link; copying it would create a second truth
 * that drifts the moment a ticket is re-parented.
 *
 * This table is what makes the confound set computable: given a window, the
 * releases that overlap it, their changes, and the initiatives behind those
 * changes.
 */
export const releaseChanges = pgTable(
  "release_changes",
  {
    releaseId: uuid("release_id").notNull().references(() => releases.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.releaseId, table.issueId] }),
    releaseIdx: index("release_changes_release_idx").on(table.releaseId),
    issueIdx: index("release_changes_issue_idx").on(table.issueId),
    companyIdx: index("release_changes_company_idx").on(table.companyId),
  }),
);
