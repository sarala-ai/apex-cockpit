import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// What an operator's OWN workstation reported about its local toolchain
// (gcloud/gh/ADC/claude/apex). One row per operator, overwritten on each
// report. This is the only truth source for operator-scoped setup items on a
// hosted cockpit — the server never probes its own container for them.
export const operatorWorkstationReports = pgTable("operator_workstation_reports", {
  userId: text("user_id").primaryKey(),
  source: text("source").notNull(),
  report: jsonb("report").$type<Record<string, unknown>>().notNull(),
  reportedAt: timestamp("reported_at", { withTimezone: true }).notNull().defaultNow(),
});
