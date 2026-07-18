CREATE TABLE IF NOT EXISTS "org_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_memberships_org_user_unique_idx" ON "org_memberships" USING btree ("org_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_memberships_user_status_idx" ON "org_memberships" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_memberships_org_status_idx" ON "org_memberships" USING btree ("org_id","status");
