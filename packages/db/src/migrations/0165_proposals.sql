-- PROPOSALS — structured objects become a reviewable artifact.
--
-- Design files are reviewable (rendered at a gate). Code diffs are reviewable.
-- Infrastructure plan-diffs are reviewable — proposed records in a table,
-- approved once, materialised on approval. STRUCTURED OBJECTS WERE NOT, and
-- that gap is why reviewing 26 reconstructed initiatives had no home in the
-- product and a spreadsheet looked like the answer.
--
-- A proposal is a list of typed records of one `kind`, carrying per-record
-- provenance so a reviewer can see at a glance which rows are reconstructions
-- and which are recorded fact. Corrections are made ON THE PROPOSAL — nothing
-- exists on the board until the single gate approves it, at which point the
-- records materialise.
--
-- `records` is jsonb rather than a child table for the same reason an
-- initiative's assumptions are: the list is read and written whole, no record
-- has identity or lifetime outside its proposal, nothing joins to one, and the
-- shape is per-kind, so a typed table would need a column union across every
-- kind that will ever exist. Zod validates on every write.
--
-- `approval_id` is nullable: a draft has no gate yet. One proposal, one gate —
-- the whole point is a single decision over the set, not a decision per row.
CREATE TABLE IF NOT EXISTS "proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "summary" text,
  "status" text NOT NULL DEFAULT 'draft',
  "records" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "proposed_by_agent_id" uuid REFERENCES "agents"("id"),
  "proposed_by_user_id" text,
  "approval_id" uuid REFERENCES "approvals"("id"),
  -- What the approval actually did to the board. Kept so an approved proposal
  -- stays an audit record of a materialisation, not just of a decision.
  "materialized_at" timestamp with time zone,
  "materialization" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "proposals_company_status_idx"
  ON "proposals" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "proposals_approval_idx" ON "proposals" ("approval_id");
