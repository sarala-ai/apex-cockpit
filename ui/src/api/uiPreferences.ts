import type { UiPreferences, UpsertUiPreferences } from "@paperclipai/shared";
import { api } from "./client";

export const uiPreferencesApi = {
  get: () => api.get<UiPreferences>("/ui-preferences/me"),
  update: (data: UpsertUiPreferences) => api.put<UiPreferences>("/ui-preferences/me", data),
};
