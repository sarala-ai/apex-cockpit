-- APEX-75 — per-user UI preferences, starting with the theme choice.
--
-- One row per board user. The theme is a tri-state preference: an explicit
-- 'light' or 'dark', or 'system' to follow the OS. Absence of a row means the
-- user has never chosen — the UI resolves that to dark (product default).
create table if not exists "user_ui_preferences" (
  "id" uuid primary key default gen_random_uuid(),
  "user_id" text not null,
  "theme" text not null constraint "user_ui_preferences_theme_check" check ("theme" in ('light', 'dark', 'system')),
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);
--> statement-breakpoint
create unique index if not exists "user_ui_preferences_user_uq" on "user_ui_preferences" ("user_id");
