import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { orgs } from "./orgs.js";
import { authUsers } from "./auth.js";

/**
 * Org membership — maps a user to an Org with a role (apex-tower onboarding).
 *
 * The first user to set up an empty instance (creates the Org + cloud/repo config)
 * becomes the `owner` (`status: active`); every subsequent user is mapped as a
 * `member` (`status: pending`) and an owner/admin approves them. One row locally
 * (the founder), many rows when cloud-connected to an enterprise. Top of the
 * resolver cascade: user → org → company → project → config.
 */
export const orgMemberships = pgTable(
  "org_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id),
    /** owner | admin | member */
    role: text("role").notNull().default("member"),
    /** active | pending */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUserUniqueIdx: uniqueIndex("org_memberships_org_user_unique_idx").on(table.orgId, table.userId),
    userStatusIdx: index("org_memberships_user_status_idx").on(table.userId, table.status),
    orgStatusIdx: index("org_memberships_org_status_idx").on(table.orgId, table.status),
  }),
);
