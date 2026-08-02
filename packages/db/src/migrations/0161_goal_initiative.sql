-- The initiative is the object the product-engineering model turns on: the
-- thing that carries a budget, a stop condition and — when there is a genuine
-- question — a hypothesis, and that closes as validated / stopped / revised /
-- expired. Goals already had the right structure (hierarchical via parent_id,
-- joined to projects via project_goals); what was missing was the vocabulary
-- and these five fields. `initiative` joins GOAL_LEVELS in shared constants;
-- level is plain text here, so no type change is needed for it.
--
-- `closure` is a SEPARATE column from `status`, not four new status values.
-- status ("planned/active/achieved/cancelled") already means something for
-- company, team, agent and task goals, and "achieved" is not the same claim as
-- "validated" — an initiative that is honestly stopped or falsified is a
-- success of the method and a failure of the goal, and one column cannot say
-- both. closure_reason is the evidence slot: every closure keeps its reason.
--
-- assumptions is jsonb because the risk sheet is read and written as a unit —
-- nothing joins to a single assumption, nothing filters across initiatives by
-- one, and no assumption outlives its initiative. The typed-column preference
-- applies to fields that get queried; the shape here is enforced by the Zod
-- schema on every write instead.
--
-- ALL NULLABLE, NOTHING BACKFILLED. Every existing goal predates the
-- distinction; writing a default would declare something nobody checked.
-- Existing readers (including goals.status = 'active' lookups) are untouched.
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "closure" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "closure_reason" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "assumptions" jsonb;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "budget" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "stop_condition" text;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "hypothesis" text;
