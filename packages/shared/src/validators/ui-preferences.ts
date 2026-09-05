import { z } from "zod";

export const themePreferenceSchema = z.enum(["light", "dark", "system"]);

export const uiPreferencesSchema = z.object({
  // Null means the user has never chosen; the UI resolves that to its
  // default (dark, per APEX-75).
  theme: themePreferenceSchema.nullable(),
  // The Veil (APEX-102) escape hatch: skip due()-gating and show every
  // registered surface.
  showAllSurfaces: z.boolean(),
  updatedAt: z.coerce.date().nullable(),
});

// theme and showAllSurfaces are independently settable — a PUT may patch
// either or both, but must supply at least one.
export const upsertUiPreferencesSchema = z
  .object({
    theme: themePreferenceSchema.optional(),
    showAllSurfaces: z.boolean().optional(),
  })
  .refine((v) => v.theme !== undefined || v.showAllSurfaces !== undefined, {
    message: "at least one of theme or showAllSurfaces is required",
  });

export type ThemePreference = z.infer<typeof themePreferenceSchema>;
export type UiPreferences = z.infer<typeof uiPreferencesSchema>;
export type UpsertUiPreferences = z.infer<typeof upsertUiPreferencesSchema>;
