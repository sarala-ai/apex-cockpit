-- The Veil: a new org starts with almost every nav
-- surface veiled, and org-facts.ts's due() rules (packages/shared/src/
-- surfaces.ts) unveil them as evidence accumulates (a repo bound, a run
-- started, a PR opened, ...). org_surface_flags is the CURRENT state — one
-- row per (org, surface) — and org_surface_flag_events is the append-only
-- history of every write to it, so "who unveiled this and why" is always
-- answerable. A rule-sourced write must never clobber an explicit
-- chat/api/user unveil (see server/src/services/surface-flags.ts) — that
-- invariant lives in code, not a constraint, because a future explicit
-- RE-veil is legitimate and this table cannot tell the two apart from shape
-- alone.
CREATE TABLE IF NOT EXISTS "org_surface_flags" (
	"org_id" uuid NOT NULL,
	"surface_key" text NOT NULL,
	"unveiled" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"actor_user_id" text,
	"actor_run_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_surface_flags_org_id_surface_key_pk" PRIMARY KEY("org_id","surface_key"),
	CONSTRAINT "org_surface_flags_source_check" CHECK ("org_surface_flags"."source" in ('chat', 'api', 'user', 'default', 'rule'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_surface_flag_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"surface_key" text NOT NULL,
	"unveiled" boolean NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"actor_user_id" text,
	"actor_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_surface_flag_events_source_check" CHECK ("org_surface_flag_events"."source" in ('chat', 'api', 'user', 'default', 'rule'))
);
--> statement-breakpoint
ALTER TABLE "org_surface_flags" ADD CONSTRAINT "org_surface_flags_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_surface_flag_events" ADD CONSTRAINT "org_surface_flag_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_surface_flags_org_idx" ON "org_surface_flags" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_surface_flag_events_org_surface_idx" ON "org_surface_flag_events" USING btree ("org_id","surface_key","created_at");--> statement-breakpoint
-- The Veil escape hatch: skip due()-gating entirely and show every registered
-- surface, per-user.
ALTER TABLE "user_ui_preferences" ADD COLUMN "show_all_surfaces" boolean DEFAULT false NOT NULL;
