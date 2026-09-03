-- Operator-scoped setup items (gcloud/gh/ADC/claude/apex on the operator's
-- machine) are reported BY that machine; a hosted cockpit never probes its own
-- container for them. One row per operator, replaced on every report.
CREATE TABLE IF NOT EXISTS "operator_workstation_reports" (
	"user_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"report" jsonb NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL
);
