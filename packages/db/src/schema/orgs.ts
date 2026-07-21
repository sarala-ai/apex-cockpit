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
  /**
   * Governance posture — the hardening dial. `individual` (default) is the loose,
   * self-service end: personal repos + personal GCP projects, advisory (not
   * access-controlling) associations, no App-install/WIF/admin-approval gating.
   * `team`/`enterprise` turn on the heavier governance (App-install boundary,
   * admin-authoritative binding, approval). Read by the single scope-policy seam
   * (server/src/apex/scope-policy.ts) — see [posture×role authz].
   */
  governancePosture: text("governance_posture").notNull().default("individual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
