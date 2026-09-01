import { pgTable, uuid, text, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Resource-attribution mapping (spec: provenance-at-birth follow-on) — the
// cockpit's own record of "who/what owns this GCP resource", layered on top of
// the ephemeral per-listing classification gcp_inventory computes live (label /
// registry / exception, see gcp-inventory-store.ts). This table is what makes
// that classification durable and correctable:
//   - `auto_mapped` rows come from importing an apex-core `resource-mapper`
//     report's `exact` section (deterministic workflow-input → resource-URI
//     matches) — see POST /observe/attribution/import.
//   - `manual` rows are a human's conflict-resolution decision — see POST
//     /observe/attribution/manual. Manual always wins (precedence: manual >
//     cloud label > auto_mapped), enforced in gcp-inventory-store's merge, not
//     here — this table just stores the one row per (projectId, resourceUri).
//
// `projectId` is the GCP project id string (e.g. "finpilot-dev"), NOT a FK to
// the cockpit `projects` table — attribution is scoped to a cloud project, not
// a cockpit workstream.
export const resourceAttributions = pgTable(
  "resource_attributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: text("project_id").notNull(),
    resourceUri: text("resource_uri").notNull(),
    assetType: text("asset_type").notNull(),
    source: text("source").notNull(),
    workflow: text("workflow"),
    repo: text("repo"),
    env: text("env"),
    confidence: text("confidence"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    decidedBy: text("decided_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectResourceUnique: unique("resource_attributions_project_resource_uri_unique").on(
      table.projectId,
      table.resourceUri,
    ),
    companyIdx: index("resource_attributions_company_idx").on(table.companyId),
    companyProjectIdx: index("resource_attributions_company_project_idx").on(
      table.companyId,
      table.projectId,
    ),
  }),
);
