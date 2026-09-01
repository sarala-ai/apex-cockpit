ALTER TABLE "orgs" ADD COLUMN IF NOT EXISTS "governance_posture" text DEFAULT 'individual' NOT NULL;
