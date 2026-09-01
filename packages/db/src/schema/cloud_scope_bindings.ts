import { sql } from "drizzle-orm";
import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Cloud-scope binding — which GCP projects + GitHub repos are scoped to a given
 * Org or Company (apex-tower §1). Product/project-level binding stays on
 * `projects.env` (writeCloudBinding); this table adds the ORG and COMPANY levels
 * above it, forming the org → company → project scope cascade the resolver reads.
 */
export const cloudScopeBindings = pgTable(
  "cloud_scope_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeType: text("scope_type").notNull(), // 'org' | 'company'
    scopeId: uuid("scope_id").notNull(),
    gcpProjects: jsonb("gcp_projects").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    githubRepos: jsonb("github_repos").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeUniqueIdx: uniqueIndex("cloud_scope_bindings_scope_idx").on(t.scopeType, t.scopeId),
  }),
);
