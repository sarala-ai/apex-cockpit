import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecretProviderConfigs } from "./company_secret_provider_configs.js";
import { orgs } from "./orgs.js";

export const userSecretDefinitions = pgTable(
  "user_secret_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // A slot lives in exactly one home: a company, or an org (operator
    // credentials every company in the org resolves from).
    scope: text("scope").notNull().default("company"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    orgId: uuid("org_id").references(() => orgs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    provider: text("provider").notNull().default("local_encrypted"),
    managedMode: text("managed_mode").notNull().default("paperclip_managed"),
    providerConfigId: uuid("provider_config_id").references(() => companySecretProviderConfigs.id, { onDelete: "set null" }),
    providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>(),
    usageGuidance: text("usage_guidance"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("user_secret_definitions_company_status_idx").on(table.companyId, table.status),
    companyProviderIdx: index("user_secret_definitions_company_provider_idx").on(table.companyId, table.provider),
    providerConfigIdx: index("user_secret_definitions_provider_config_idx").on(table.providerConfigId),
    orgStatusIdx: index("user_secret_definitions_org_status_idx").on(table.orgId, table.status),
    companyKeyUq: uniqueIndex("user_secret_definitions_company_key_uq")
      .on(table.companyId, table.key)
      .where(sql`${table.scope} = 'company' and ${table.deletedAt} is null`),
    orgKeyUq: uniqueIndex("user_secret_definitions_org_key_uq")
      .on(table.orgId, table.key)
      .where(sql`${table.scope} = 'org' and ${table.deletedAt} is null`),
    scopeShapeCheck: check(
      "user_secret_definitions_scope_shape_check",
      sql`(
        ${table.scope} = 'company' and ${table.companyId} is not null and ${table.orgId} is null
      ) or (
        ${table.scope} = 'org' and ${table.orgId} is not null and ${table.companyId} is null
      )`,
    ),
  }),
);
