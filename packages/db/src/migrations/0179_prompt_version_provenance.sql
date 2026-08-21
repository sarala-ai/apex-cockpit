-- APEX-122 seam conformance: add contract-provenance columns to company_prompt_versions
-- and ensure every version is walkable on the lineage spine.
--
-- Mirrors the shape added to company_skills in migration 0177:
--   run_id        → FK to heartbeat_runs (nullable; null when created by a human)
--   producer_kind → discriminator ('agent' | 'user' | null)
--   producer_id   → agent/user UUID (polymorphic, no FK)
--
-- All columns are nullable; existing rows are unaffected.

alter table "company_prompt_versions" add column if not exists "run_id" uuid references "heartbeat_runs"("id") on delete set null;
--> statement-breakpoint
alter table "company_prompt_versions" add column if not exists "producer_kind" text;
--> statement-breakpoint
alter table "company_prompt_versions" add column if not exists "producer_id" uuid;
--> statement-breakpoint

create index if not exists "company_prompt_versions_run_idx" on "company_prompt_versions" ("company_id", "run_id");
