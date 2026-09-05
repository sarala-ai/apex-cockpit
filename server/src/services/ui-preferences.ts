import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userUiPreferences } from "@paperclipai/db";
import type { UiPreferences, UpsertUiPreferences } from "@paperclipai/shared";

function toPreferences(
  theme: string | null,
  showAllSurfaces: boolean | null | undefined,
  updatedAt: Date | null,
): UiPreferences {
  const valid = theme === "light" || theme === "dark" || theme === "system" ? theme : null;
  return { theme: valid, showAllSurfaces: showAllSurfaces ?? false, updatedAt };
}

export function uiPreferenceService(db: Db) {
  return {
    async getForUser(userId: string): Promise<UiPreferences> {
      const row = await db.query.userUiPreferences.findFirst({
        where: eq(userUiPreferences.userId, userId),
      });
      return toPreferences(row?.theme ?? null, row?.showAllSurfaces, row?.updatedAt ?? null);
    },

    /** Patches whichever of theme/showAllSurfaces is provided. On first
     *  write for a user, an omitted `theme` falls back to "system" (the
     *  column is NOT NULL) — matches the UI's own default resolution. */
    async upsertForUser(userId: string, patch: UpsertUiPreferences): Promise<UiPreferences> {
      const now = new Date();
      const existing = await db.query.userUiPreferences.findFirst({
        where: eq(userUiPreferences.userId, userId),
      });
      const theme = patch.theme ?? existing?.theme ?? "system";
      const showAllSurfaces = patch.showAllSurfaces ?? existing?.showAllSurfaces ?? false;
      const [row] = await db
        .insert(userUiPreferences)
        .values({ userId, theme, showAllSurfaces, updatedAt: now })
        .onConflictDoUpdate({
          target: [userUiPreferences.userId],
          set: { theme, showAllSurfaces, updatedAt: now },
        })
        .returning();
      return toPreferences(row?.theme ?? theme, row?.showAllSurfaces ?? showAllSurfaces, row?.updatedAt ?? now);
    },
  };
}
