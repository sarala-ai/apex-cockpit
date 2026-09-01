import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { approvals } from "./approvals.js";

/**
 * One proposed record. `fields` is kind-shaped and validated by the kind's Zod
 * schema on write — see `proposalRecordSchema` in @paperclipai/shared, which is
 * what actually enforces this.
 */
export type ProposalRecordRow = {
  ref: string;
  targetId?: string | null;
  provenance: { kind: "confirmed" | "inferred"; source?: string | null };
  fields: Record<string, unknown>;
  note?: string | null;
  excluded?: boolean | null;
  correctedAt?: string | null;
  correctedByUserId?: string | null;
};

export type ProposalMaterialization = {
  created: string[];
  updated: string[];
  skipped: string[];
  errors: Array<{ ref: string; error: string }>;
};

/**
 * A reviewable artifact carrying typed records. See migration 0164 for why this
 * object exists at all and why `records` is jsonb.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    /** Determines the record shape, the rendered columns and the materialiser. */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").notNull().default("draft"),
    records: jsonb("records").$type<ProposalRecordRow[]>().notNull().default([]),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id),
    proposedByUserId: text("proposed_by_user_id"),
    /** The single gate. Null until submitted — a draft has no decision pending. */
    approvalId: uuid("approval_id").references(() => approvals.id),
    materializedAt: timestamp("materialized_at", { withTimezone: true }),
    materialization: jsonb("materialization").$type<ProposalMaterialization>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("proposals_company_status_idx").on(table.companyId, table.status),
    approvalIdx: index("proposals_approval_idx").on(table.approvalId),
  }),
);
