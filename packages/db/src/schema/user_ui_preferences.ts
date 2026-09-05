import { pgTable, uuid, text, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const userUiPreferences = pgTable(
  "user_ui_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    // Constrained to 'light' | 'dark' | 'system' by a CHECK in the migration.
    theme: text("theme").notNull(),
    // The Veil (APEX-102) escape hatch: skip due()-gating entirely and show
    // every registered surface. Added 0186.
    showAllSurfaces: boolean("show_all_surfaces").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUq: uniqueIndex("user_ui_preferences_user_uq").on(table.userId),
  }),
);
