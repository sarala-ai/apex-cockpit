-- Five gaps the model could not express, all of them found by importing APEX's
-- own 27 initiatives onto the board rather than by reasoning about the schema.
-- See docs/architecture/initiative-discipline.md.
--
-- `hold` — M-10 gave projects `on_hold` and stopped there. Two real initiatives
-- ("Zero-token agents", "A new project starts from a template") read `active`
-- because two of their projects had completed, when the honest reading was
-- *valid, not now*. No arrangement of child rows can say that: pausing is a
-- DECISION, like `closure`, not a consequence, like `status`. So it is asserted
-- here and it overrides the derived reading. One nullable jsonb object rather
-- than a reason column plus a date column, because presence is the assertion —
-- "held with no reason" and "a reason with no hold" are both unrepresentable
-- this way, and every closure keeping its evidence is supposed to be structural
-- rather than aspirational. Shape ({ reason, since, byUserId?, byAgentId?,
-- reviewDate? }) enforced by Zod on every write, matching `assumptions` (0161)
-- and `validation_criteria` (0163).
--
-- `hypotheses` — fourteen hypotheses had to be folded into ten free-text
-- `hypothesis` fields; three of those strings carry two or three questions, and
-- their verdicts are prose. A list, for exactly the reasons `assumptions` and
-- `validation_criteria` are lists, and stored the same way: read and written
-- whole, nothing joins to a single hypothesis, none outlives its initiative.
-- Each is { id, statement, verdict (untested|supported|falsified|inconclusive),
-- evidence?, testedAt? }, and any verdict other than `untested` REQUIRES
-- evidence and a date — a verdict may not exceed its evidence (§4a).
--
-- THE `hypothesis` TEXT COLUMN STAYS, AND IS NOT MIGRATED. There is no clean
-- data step: splitting a three-question string in SQL would invent sentence
-- boundaries, and copying each field into a single-element array with verdict
-- `untested` would erase answers that were actually recorded in the prose.
-- Both are fabrications, which is what NOTHING BACKFILLED has meant on every
-- initiative column so far. The text stays readable, the UI renders it beside
-- the structured list, and a person restates each question when they next look
-- at that initiative.
--
-- `folded_into_*` on projects — `folded` is the third project closure the model
-- doc has always listed ("delivered · cancelled · folded into another project")
-- and the schema never had, so "Skill packs as the moat" was recorded as
-- `cancelled` with prose explaining that it had not, in fact, been abandoned.
-- Two nullable links because a fold has two honest shapes — into a sibling
-- project, or into another initiative — and at most one is true. Neither is
-- required: imported history folds into things that are not on the board yet,
-- and refusing those folds would push them back to `cancelled`, which is the
-- misstatement being removed. The board renders a missing destination in words.
--
-- ALSO IN THIS CHANGE, WITH NO DDL: two new project statuses in shared
-- constants, `built` and `folded`. `status` is plain text, so no type change is
-- needed. `built` is delivered-but-never-exercised — the state four real
-- projects (apex-eval, the Observe pillar, the GCP observability provider, the
-- observability skill pack) needed and could not have, leaving them parked in
-- `in_progress` because `completed` would have claimed an exercise nobody had
-- performed. And a new derived initiative status, `partial`, so an initiative
-- with cancelled projects behind it can no longer report plain `delivered` —
-- the MCP-first case, where two failed projects dropped out of the live set and
-- the board reported completeness for a falsified sentence.
--
-- ALL NULLABLE, NOTHING BACKFILLED. No initiative is put on hold by this
-- migration and no project is restated as built or folded: those are decisions,
-- and a migration that made them would be inventing a record of a decision
-- nobody took.
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "hold" jsonb;
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "hypotheses" jsonb;

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "folded_into_project_id" uuid;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "folded_into_goal_id" uuid;

DO $$
BEGIN
  ALTER TABLE "projects"
    ADD CONSTRAINT "projects_folded_into_project_id_fkey"
    FOREIGN KEY ("folded_into_project_id") REFERENCES "projects"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "projects"
    ADD CONSTRAINT "projects_folded_into_goal_id_fkey"
    FOREIGN KEY ("folded_into_goal_id") REFERENCES "goals"("id");
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
