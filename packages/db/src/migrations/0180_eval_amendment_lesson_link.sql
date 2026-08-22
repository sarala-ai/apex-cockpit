-- APEX-148 — Cohesion slice step 3: verdict → lesson → amendment.
--
-- Closes the APEX-146 chain by adding two columns to eval_amendments:
--   lesson_id  — back-ref to the eval_lesson that motivated this amendment
--   status     — lifecycle state of the amendment ('proposed' | 'accepted' | 'rejected')
--
-- Both are additive/nullable-safe:
--   lesson_id is nullable (existing rows have no lesson context)
--   status has a NOT NULL DEFAULT so existing rows get 'proposed'

alter table "eval_amendments"
  add column if not exists "lesson_id" uuid references "eval_lessons"("id") on delete set null;
--> statement-breakpoint

alter table "eval_amendments"
  add column if not exists "status" text not null default 'proposed';
--> statement-breakpoint

create index if not exists "eval_amendments_company_lesson_idx"
  on "eval_amendments" ("company_id", "lesson_id");
