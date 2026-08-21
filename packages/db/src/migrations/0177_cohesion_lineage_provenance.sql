-- APEX-146 — Cohesion invariant: spine + provenance + lineage (additive, non-breaking).
--
-- Every component artifact must sit on the correlation SPINE (run_id FK to
-- heartbeat_runs), carry PROVENANCE (producer_kind / producer_id /
-- producer_version), and emit a LINEAGE edge. This migration materialises the
-- cockpit DB slice of that invariant. Nothing is removed or repurposed.
--
-- 1 · Promote issues.origin_run_id text → uuid FK.
--     Existing values were always stored as UUID strings (set by randomUUID()
--     in the application layer). The cast is safe; values that are not valid
--     UUID strings are silently coerced to NULL rather than aborting the
--     migration. The FK is added NOT VALID so it does not scan the existing
--     rows (which may reference deleted runs) — only new rows are enforced.
alter table "issues"
  alter column "origin_run_id" type uuid
  using case
    when "origin_run_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then "origin_run_id"::uuid
    else null
  end;
--> statement-breakpoint
alter table "issues"
  add constraint "issues_origin_run_id_heartbeat_runs_id_fk"
  foreign key ("origin_run_id") references "heartbeat_runs"("id") on delete set null
  not valid;
--> statement-breakpoint

-- 2 · Nullable spine + provenance columns on company_skills.
--     All additive/nullable; existing rows are unaffected.
alter table "company_skills" add column if not exists "run_id" uuid references "heartbeat_runs"("id") on delete set null;
--> statement-breakpoint
alter table "company_skills" add column if not exists "producer_kind" text;
--> statement-breakpoint
alter table "company_skills" add column if not exists "producer_id" uuid;
--> statement-breakpoint
alter table "company_skills" add column if not exists "producer_version" text;
--> statement-breakpoint

-- 3 · lineage_edges — standalone derivation graph, zero changes to existing
--     tables. Pivots cross-DB on run_id. Extends the issue_relations pattern.
create table if not exists "lineage_edges" (
  "id" uuid primary key default gen_random_uuid(),
  "company_id" uuid not null references "companies"("id") on delete cascade,
  "run_id" uuid references "heartbeat_runs"("id") on delete set null,
  "from_kind" text not null,
  "from_id" uuid not null,
  "to_kind" text not null,
  "to_id" uuid not null,
  "edge_type" text not null,
  "created_at" timestamp with time zone not null default now()
);
--> statement-breakpoint
create index if not exists "lineage_edges_company_to_idx" on "lineage_edges" ("company_id", "to_kind", "to_id");
--> statement-breakpoint
create index if not exists "lineage_edges_company_from_idx" on "lineage_edges" ("company_id", "from_kind", "from_id");
--> statement-breakpoint
create index if not exists "lineage_edges_company_run_idx" on "lineage_edges" ("company_id", "run_id");
--> statement-breakpoint

-- 4 · eval_lessons — terminal nodes: insights extracted from evaluation runs.
create table if not exists "eval_lessons" (
  "id" uuid primary key default gen_random_uuid(),
  "company_id" uuid not null references "companies"("id") on delete cascade,
  "run_id" uuid references "heartbeat_runs"("id") on delete set null,
  "issue_id" uuid references "issues"("id") on delete set null,
  "producer_kind" text,
  "producer_id" uuid,
  "producer_version" text,
  "lesson_kind" text not null default 'general',
  "summary" text not null,
  "detail" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);
--> statement-breakpoint
create index if not exists "eval_lessons_company_run_idx" on "eval_lessons" ("company_id", "run_id");
--> statement-breakpoint
create index if not exists "eval_lessons_company_issue_idx" on "eval_lessons" ("company_id", "issue_id");
--> statement-breakpoint
create index if not exists "eval_lessons_company_kind_idx" on "eval_lessons" ("company_id", "lesson_kind");
--> statement-breakpoint

-- 5 · eval_amendments — terminal nodes: corrections to prior decisions.
create table if not exists "eval_amendments" (
  "id" uuid primary key default gen_random_uuid(),
  "company_id" uuid not null references "companies"("id") on delete cascade,
  "run_id" uuid references "heartbeat_runs"("id") on delete set null,
  "issue_id" uuid references "issues"("id") on delete set null,
  "producer_kind" text,
  "producer_id" uuid,
  "producer_version" text,
  "subject_kind" text not null,
  "subject_id" uuid not null,
  "summary" text not null,
  "detail" text,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now()
);
--> statement-breakpoint
create index if not exists "eval_amendments_company_run_idx" on "eval_amendments" ("company_id", "run_id");
--> statement-breakpoint
create index if not exists "eval_amendments_company_issue_idx" on "eval_amendments" ("company_id", "issue_id");
--> statement-breakpoint
create index if not exists "eval_amendments_company_subject_idx" on "eval_amendments" ("company_id", "subject_kind", "subject_id");
