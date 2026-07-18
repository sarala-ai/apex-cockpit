import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Org — the holding entity above companies (apex-tower §1). One per deployment in
 * practice (e.g. "Sarala"), but modeled as a first-class row so companies group
 * under a persisted Org and GCP/repo scoping can bind at the org level. This is
 * also the top of the resolver cascade (org → company → project).
 */
export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Linked Google Cloud Organization (from discovery), if any. */
  googleOrg: jsonb("google_org").$type<{ id: string; displayName: string } | null>(),
  /** Linked GitHub Organization login, if any. */
  githubOrg: text("github_org"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
