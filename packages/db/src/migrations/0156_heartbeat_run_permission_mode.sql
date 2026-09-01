-- Visibility stamp for flow-commissioned agent runs (server/src/apex/flow/
-- run-policy.ts): the flow coordinator stamps permission_mode='governed' +
-- permission_profile on the run it commissioned. Typed columns by doctrine
-- (never jsonb) for anything read back structurally by a route/UI. Null for
-- every run the coordinator doesn't touch (all interactive runs) — the
-- observe surface treats null as "bypass" (the fork's pre-existing default).
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "permission_mode" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "permission_profile" text;
