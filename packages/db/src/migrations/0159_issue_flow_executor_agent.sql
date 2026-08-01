-- Who executes a flow's agent steps, owned by the flow coordinator alone.
--
-- The coordinator used to read `issues.assignee_agent_id` as "who executes
-- this flow". That column has another writer: the per-issue execution policy
-- rewrites it to the REVIEWER when it intercepts a done-transition, on purpose
-- excluding the original executor so review stays independent. On any issue
-- carrying both mechanisms, the flow then commissioned its next agent step to
-- the reviewer — quietly defeating that independence.
--
-- Additive and nullable: existing flows resolve their executor on the next
-- agent node exactly as before and record it here. Nothing is backfilled,
-- because there is no honest value to backfill for a flow already in flight.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "flow_executor_agent_id" uuid;

DO $$ BEGIN
  ALTER TABLE "issues"
    ADD CONSTRAINT "issues_flow_executor_agent_id_agents_id_fk"
    FOREIGN KEY ("flow_executor_agent_id") REFERENCES "agents"("id")
    ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
