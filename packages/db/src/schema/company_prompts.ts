import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  integer,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";
import type { CompanyPromptVariable } from "@paperclipai/shared";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { sql } from "drizzle-orm";

export const companyPrompts = pgTable(
  "company_prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    currentVersionId: uuid("current_version_id").references((): AnyPgColumn => companyPromptVersions.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySlugUniqueIdx: uniqueIndex("company_prompts_company_slug_idx")
      .on(table.companyId, table.slug)
      .where(sql`${table.deletedAt} IS NULL`),
    companyCreatedIdx: index("company_prompts_company_created_idx")
      .on(table.companyId, table.createdAt)
      .where(sql`${table.deletedAt} IS NULL`),
  }),
);

export const companyPromptVersions = pgTable(
  "company_prompt_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id").notNull().references(() => companyPrompts.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    content: text("content").notNull(),
    variables: jsonb("variables").$type<CompanyPromptVariable[]>().notNull().default([]),
    commitMessage: text("commit_message"),
    authorUserId: text("author_user_id"),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    producerKind: text("producer_kind"),
    producerId: uuid("producer_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    promptRevisionUniqueIdx: uniqueIndex("company_prompt_versions_prompt_revision_idx").on(
      table.promptId,
      table.revisionNumber,
    ),
    companyPromptCreatedIdx: index("company_prompt_versions_company_prompt_created_idx").on(
      table.companyId,
      table.promptId,
      table.createdAt,
    ),
    companyRunIdx: index("company_prompt_versions_run_idx").on(table.companyId, table.runId),
  }),
);

export const companyPromptLabels = pgTable(
  "company_prompt_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    promptId: uuid("prompt_id").notNull().references(() => companyPrompts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    versionId: uuid("version_id").notNull().references(() => companyPromptVersions.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    protected: boolean("protected").notNull().default(false),
    updatedByUserId: text("updated_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    promptNameUniqueIdx: uniqueIndex("company_prompt_labels_prompt_name_idx").on(table.promptId, table.name),
    companyPromptIdx: index("company_prompt_labels_company_prompt_idx").on(table.companyId, table.promptId),
  }),
);
