-- Marks a finished run as delivered to apex-eval as a trace. Null until the
-- eval service has accepted it, so the ingest sweep is resumable.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "eval_ingested_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_eval_ingest_pending_idx" ON "heartbeat_runs" USING btree ("finished_at") WHERE "eval_ingested_at" IS NULL;
