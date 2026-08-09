import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userUiPreferences } from "@paperclipai/db";
import type { ThemePreference, UiPreferences } from "@paperclipai/shared";

function toPreferences(theme: string | null, updatedAt: Date | null): UiPreferences {
  const valid = theme === "light" || theme === "dark" || theme === "system" ? theme : null;
  return { theme: valid, updatedAt };
}

export function uiPreferenceService(db: Db) {
  return {
    async getForUser(userId: string): Promise<UiPreferences> {
      const row = await db.query.userUiPreferences.findFirst({
        where: eq(userUiPreferences.userId, userId),
      });
      return toPreferences(row?.theme ?? null, row?.updatedAt ?? null);
    },

    async upsertForUser(userId: string, theme: ThemePreference): Promise<UiPreferences> {
      const now = new Date();
      const [row] = await db
        .insert(userUiPreferences)
        .values({
          userId,
          theme,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [userUiPreferences.userId],
          set: {
            theme,
            updatedAt: now,
          },
        })
        .returning();
      return toPreferences(row?.theme ?? theme, row?.updatedAt ?? now);
    },
  };
}
