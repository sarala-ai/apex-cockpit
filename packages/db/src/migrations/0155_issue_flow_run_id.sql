-- A-node bridge: link the flow's current agent node to the heartbeat run the
-- coordinator commissioned for it. Typed column by doctrine (never jsonb);
-- the flow coordinator remains the ONLY writer of flow_* columns.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "flow_run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_flow_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("flow_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
