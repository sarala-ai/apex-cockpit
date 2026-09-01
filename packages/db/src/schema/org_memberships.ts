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
      .references(() => orgs.id, { onDelete: "cascade" }),
    // Type-level reference only — intentionally NO DB-level FK (see migration
    // 0149). The synthetic `"local-board"` actor (server/src/board-claim.ts,
    // server/src/middleware/auth.ts) used for local/dev-mode operations is not a
    // real row in `user`, so a hard FK here would break local-mode inserts. This
    // matches the fork's existing precedent for actor/user references that must
    // also accept synthetic ids: `company_memberships.principalId` (see
    // packages/db/src/schema/company_memberships.ts) is deliberately a bare
    // unconstrained `text` column for the same reason. Also documented at
    // server/src/routes/apex-scoping.ts (actorUserId doc comment: "no FK
    // enforced").
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
