-- APEX-127 phase 2: teams + team_memberships (additive human-grouping tables).
--
-- Teams group humans WITHIN a company. Both tables are new; nothing existing is
-- touched. user_id is text to match authUsers.id (better-auth string ids);
-- role is free text ('lead' | 'member'), enforced in app code like
-- company_memberships.membership_role. Fully idempotent (create ... if not exists).

create table if not exists "teams" (
	"id" uuid primary key default gen_random_uuid() not null,
	"company_id" uuid not null references "companies"("id"),
	"name" text not null,
	"slug" text not null,
	"created_at" timestamp with time zone default now() not null,
	"updated_at" timestamp with time zone default now() not null
);
--> statement-breakpoint
create unique index if not exists "teams_company_slug_unique_idx" on "teams" ("company_id", "slug");
--> statement-breakpoint
create index if not exists "teams_company_idx" on "teams" ("company_id");
--> statement-breakpoint
create table if not exists "team_memberships" (
	"id" uuid primary key default gen_random_uuid() not null,
	"team_id" uuid not null references "teams"("id"),
	"user_id" text not null,
	"role" text not null default 'member',
	"created_at" timestamp with time zone default now() not null,
	"updated_at" timestamp with time zone default now() not null
);
--> statement-breakpoint
create unique index if not exists "team_memberships_team_user_unique_idx" on "team_memberships" ("team_id", "user_id");
--> statement-breakpoint
create index if not exists "team_memberships_user_idx" on "team_memberships" ("user_id");
