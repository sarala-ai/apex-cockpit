ALTER TABLE "routines" DROP CONSTRAINT IF EXISTS "routines_assignee_agent_id_agents_id_fk";
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "routines" ADD CONSTRAINT "routines_assignee_agent_id_agents_id_fk" FOREIGN KEY ("assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
