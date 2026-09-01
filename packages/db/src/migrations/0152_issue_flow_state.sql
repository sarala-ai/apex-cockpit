-- Flow-coordinator state on issues (work-loop typed flows).
-- Typed columns by doctrine (never jsonb); the flow coordinator is the ONLY
-- writer of these columns (single-writer discipline).
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "flow_name" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "flow_node_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "flow_status" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "flow_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "flow_advanced_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_flow_status_idx" ON "issues" USING btree ("company_id","flow_status");
