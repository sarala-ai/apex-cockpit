import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { teams } from "./teams.js";

export const teamMemberships = pgTable(
  "team_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    // Matches authUsers.id (text primary key, better-auth convention) — see
    // schema/auth.ts. Team membership is human-only, so this always resolves
    // to an authUsers row.
    userId: text("user_id").notNull(),
    // 'lead' | 'member', enforced in app code (not a DB enum), consistent
    // with company_memberships.membershipRole being free text.
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamUserUniqueIdx: uniqueIndex("team_memberships_team_user_unique_idx").on(table.teamId, table.userId),
    userIdx: index("team_memberships_user_idx").on(table.userId),
  }),
);
