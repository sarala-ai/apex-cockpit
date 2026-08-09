import { z } from "zod";

export const themePreferenceSchema = z.enum(["light", "dark", "system"]);

export const uiPreferencesSchema = z.object({
  // Null means the user has never chosen; the UI resolves that to its
  // default (dark, per APEX-75).
  theme: themePreferenceSchema.nullable(),
  updatedAt: z.coerce.date().nullable(),
});

export const upsertUiPreferencesSchema = z.object({
  theme: themePreferenceSchema,
});

export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type UiPreferences = z.infer<typeof uiPreferencesSchema>;
export type UpsertUiPreferences = z.infer<typeof upsertUiPreferencesSchema>;
