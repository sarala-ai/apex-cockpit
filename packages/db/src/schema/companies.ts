import { pgTable, uuid, text, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orgs } from "./orgs.js";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Nullable: a company can outlive its Org association (ON DELETE SET NULL —
    // see migration 0149, same "org-level FK integrity" fix as 0148's routines
    // cascade gap).
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "set null" }),
    description: text("description"),
    status: text("status").notNull().default("active"),
    pauseReason: text("pause_reason"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    issuePrefix: text("issue_prefix").notNull().default("PAP"),
    // Write-once: set at creation (or by the one-time 0153 backfill for companies
    // created before this column existed). Per-company capability env vars derive
    // from it (APEX_<SLUG>_WORKFLOWS_PATH, per the capability-sync spec), so once
    // non-null it is never rewritten — enforced in companyService.update, not just
    // here. Nullable only to cover the not-yet-backfilled edge case.
    slug: text("slug"),
    issueCounter: integer("issue_counter").notNull().default(0),
    budgetMonthlyCents: integer("budget_monthly_cents").notNull().default(0),
    spentMonthlyCents: integer("spent_monthly_cents").notNull().default(0),
    attachmentMaxBytes: integer("attachment_max_bytes")
      .notNull()
      .default(10 * 1024 * 1024),
    defaultResponsibleUserId: text("default_responsible_user_id"),
    requireBoardApprovalForNewAgents: boolean("require_board_approval_for_new_agents")
      .notNull()
      .default(false),
    feedbackDataSharingEnabled: boolean("feedback_data_sharing_enabled")
      .notNull()
      .default(false),
    feedbackDataSharingConsentAt: timestamp("feedback_data_sharing_consent_at", { withTimezone: true }),
    feedbackDataSharingConsentByUserId: text("feedback_data_sharing_consent_by_user_id"),
    feedbackDataSharingTermsVersion: text("feedback_data_sharing_terms_version"),
    brandColor: text("brand_color"),
    // GitHub projection (work-loop doctrine): mirror process lifecycle onto
    // GitHub issues — GitHub is the canonical conversation/audit surface, the
    // board stays the canonical execution store. Opt-in per company, off by
    // default.
    //
    // DORMANT since 0173: the projection implementation belonged to the flow
    // front-end and was deleted with it (nothing reads these columns today).
    // They are kept because the setting is the right one and a projection
    // re-hosted on the pipeline step host wants exactly this shape — but
    // nothing is projected until that exists.
    githubProjectionEnabled: boolean("github_projection_enabled").notNull().default(false),
    githubProjectionRepo: text("github_projection_repo"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issuePrefixUniqueIdx: uniqueIndex("companies_issue_prefix_idx").on(table.issuePrefix),
    slugUniqueIdx: uniqueIndex("companies_slug_idx")
      .on(table.slug)
      .where(sql`${table.slug} IS NOT NULL`),
  }),
);
