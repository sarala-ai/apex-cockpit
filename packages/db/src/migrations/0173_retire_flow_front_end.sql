-- Retire the flow front-end — step 5 of the execution-substrate merge
-- (docs/architecture/execution-substrate.md §6, process-definition.md §6.2).
--
-- Steps 1–4 landed: one case model, one step executor, `run · agent · gate`,
-- and the four typed lifecycles seeded as pipelines. The deletion did not, so
-- the product has been running TWO implementations of the same job. That is
-- not theoretical: the flow coordinator filled an assignee vacuum before
-- commissioning (`resolveExecutorAgent`) and the pipeline agent port was
-- ported without it, so every lifecycle agent step queued a run the heartbeat
-- immediately cancelled as `issue_assignee_changed` (observed live on APEX-14
-- at the `spec` stage; fixed in c135250d2). The general form of that bug
-- recurs for as long as two implementations exist.
--
-- This migration removes the accommodations that exist ONLY so a flow-shaped
-- case could live in `pipeline_cases`:
--
--   1. migrate flow-shaped case rows onto pipeline + stage,
--   2. restore `pipeline_id` / `stage_id` to NOT NULL,
--   3. drop the two-branch shape check and the flow-only unique index,
--   4. narrow `definition_kind` to its one remaining member,
--   5. drop the seven `issues.flow_*` mirror columns.

-- ---------------------------------------------------------------------------
-- 1 · Migrate flow-shaped cases onto the pipeline that replaced their flow.
--
-- The four typed flows (`chore`, `bug`, `design-change`, `feature`) were seeded
-- as pipelines keyed by the same names, and a flow node id was carried into
-- `step_key`, which is exactly a stage key. So the mapping is a lookup, not a
-- translation: (company, pipeline.key = definition_ref) and
-- (stage.key = step_key). Where both resolve, the row becomes pipeline-shaped
-- in place and keeps its id, version, lease, parent, links and event history.
-- ---------------------------------------------------------------------------

update "pipeline_cases" as c
set "pipeline_id" = p."id",
    "stage_id" = s."id",
    "definition_kind" = 'pipeline',
    "definition_ref" = p."id"::text,
    "updated_at" = now()
from "pipelines" as p
join "pipeline_stages" as s on s."pipeline_id" = p."id"
where c."definition_kind" = 'flow'
  and p."company_id" = c."company_id"
  and p."key" = c."definition_ref"
  and s."key" = c."step_key";

-- Anything left is a flow case whose definition has no pipeline counterpart,
-- or whose step key names no stage. It is NOT repaired here, for the same
-- reason 0168 refused to invent a step for a row with a status but no node id:
-- writing a fabricated pointer into the authoritative column turns a visible
-- problem into an invisible one. It is also not deleted — that is live work,
-- and a migration is the wrong actor to decide it should stop existing.
--
-- So the migration REFUSES, and says exactly what to do. On every instance
-- where the collapse was followed this selects nothing and the block is inert.
do $$
declare
  stranded text;
  stranded_count integer;
begin
  select count(*), string_agg(format('%s (definition_ref=%s, step_key=%s)', "id", "definition_ref", "step_key"), ', ')
    into stranded_count, stranded
  from "pipeline_cases"
  where "definition_kind" = 'flow';

  if stranded_count > 0 then
    raise exception using
      errcode = 'raise_exception',
      message = format(
        '0173 cannot retire the flow front-end: %s flow-defined case(s) do not map onto any pipeline stage.',
        stranded_count),
      detail = stranded,
      hint = 'Create (or fix the key of) the pipeline that replaces each flow, and a stage whose key matches the '
             'case step_key, then re-run. If the work is genuinely abandoned, retire or delete the case rows '
             'deliberately first — this migration will not decide that for you.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2–4 · Restore the case shape.
--
-- Order matters: the two-branch shape check permits `pipeline_id is null` for
-- a flow row, so it has to go before NOT NULL can be asserted, and the
-- definition_kind check has to widen-then-narrow rather than be edited in
-- place.
-- ---------------------------------------------------------------------------

alter table "pipeline_cases" drop constraint if exists "pipeline_cases_definition_shape_check";

drop index if exists "pipeline_cases_flow_case_key_uq";

alter table "pipeline_cases" alter column "pipeline_id" set not null;
alter table "pipeline_cases" alter column "stage_id" set not null;

alter table "pipeline_cases" drop constraint if exists "pipeline_cases_definition_kind_check";
alter table "pipeline_cases"
  add constraint "pipeline_cases_definition_kind_check"
  check ("definition_kind" = 'pipeline');

comment on column "pipeline_cases"."definition_kind" is
  'Always ''pipeline'' since 0173. Retained rather than dropped because it is the discriminator a future second definition kind would reuse, and dropping a column to re-add it later is the more expensive mistake.';
comment on column "pipeline_cases"."definition_ref" is
  'The owning pipeline id, as text.';
comment on column "pipeline_cases"."step_key" is
  'Authoritative current-step pointer (a stage key). `stage_id` is the denormalised convenience that moves with it.';
comment on column "pipeline_cases"."stage_id" is
  'Denormalised convenience for the current step; moves with step_key.';

-- ---------------------------------------------------------------------------
-- 5 · Drop the flow mirror columns on `issues`.
--
-- Every one of them carries a `COMMENT ON COLUMN` from 0167 naming this exact
-- step. They are worse than dead now: they are NULL for every pipeline case,
-- so a reader who trusts them concludes a lifecycle has not started when it
-- has. `flow_executor_agent_id` goes with them — the sticky executor lives on
-- `pipeline_cases.step_executor_agent_id`, which is per-case rather than
-- per-issue and is what the agent step already reads.
-- ---------------------------------------------------------------------------

drop index if exists "issues_company_flow_status_idx";

alter table "issues"
  drop column if exists "flow_name",
  drop column if exists "flow_node_id",
  drop column if exists "flow_status",
  drop column if exists "flow_run_id",
  drop column if exists "flow_started_at",
  drop column if exists "flow_advanced_at",
  drop column if exists "flow_executor_agent_id";
