import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Cross-entity derivation graph — one row per lineage edge.
 *
 * Keyed to `run_id` so cross-DB pivots use only the spinal `apex.run.id`.
 * Each DB (cockpit, gateway, apex-eval) owns its own copy of this table;
 * no cross-DB FKs are used. Extends the issue_relations pattern.
 *
 * APEX-146 cohesion invariant: every artifact must emit ≥1 edge where
 * `to_id` = the artifact's UUID (Q3 of the evaluator seam questions).
 */
export const lineageEdges = pgTable(
  "lineage_edges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    fromKind: text("from_kind").notNull(),
    fromId: uuid("from_id").notNull(),
    toKind: text("to_kind").notNull(),
    toId: uuid("to_id").notNull(),
    edgeType: text("edge_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyToIdx: index("lineage_edges_company_to_idx").on(table.companyId, table.toKind, table.toId),
    companyFromIdx: index("lineage_edges_company_from_idx").on(table.companyId, table.fromKind, table.fromId),
    companyRunIdx: index("lineage_edges_company_run_idx").on(table.companyId, table.runId),
  }),
);
