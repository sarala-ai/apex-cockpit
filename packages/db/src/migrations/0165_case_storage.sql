-- One case model under two front-ends — step 1 of the execution-substrate
-- merge (docs/architecture/execution-substrate.md §6).
--
-- Today there are two runtime stores for the same idea:
--
--   * pipelines keep a proper case row (`pipeline_cases`) with a version, a
--     lease, a parent, a terminal and a typed event log — but the case is
--     bolted to `pipeline_stages` by a foreign key, so ONLY a pipeline-defined
--     process can own one;
--   * flows keep their state in seven columns on `issues` (flow_name,
--     flow_node_id, flow_status, flow_run_id, flow_started_at,
--     flow_advanced_at, flow_executor_agent_id) with no version and, in
--     practice, more than one writer. That is not a theoretical complaint: on
--     our own board APE-5 was closed `done` while its gate still read
--     `waiting_gate` — a gate that never fired recorded as a closure.
--
-- This migration generalises the EXISTING case rather than introducing a
-- second `cases` table. The choice is deliberate: it is purely additive, every
-- pipeline query keeps working unchanged, and it does not require rewriting a
-- 5000-line service to route through a view. The cost is a table whose name
-- now under-describes it; that is a rename, and a rename is cheaper than a
-- migration of live semantics.
--
-- The generalisation is one idea: **the current step is addressed by KEY**. A
-- flow node id is a string in a YAML file and a stage key is a string on a
-- row; they are the same kind of thing, and once the pointer is a key rather
-- than a foreign key into stage rows, one case can serve both.

alter table "pipeline_cases"
  add column if not exists "definition_kind" text not null default 'pipeline',
  add column if not exists "definition_ref" text,
  add column if not exists "step_key" text;

-- A flow-defined case has no pipeline and no stage row to point at. Dropping
-- NOT NULL is what makes that expressible; the shape check below is what keeps
-- it from becoming a licence for half-populated rows.
alter table "pipeline_cases" alter column "pipeline_id" drop not null;
alter table "pipeline_cases" alter column "stage_id" drop not null;

-- Backfill every existing (pipeline-defined) case. `definition_ref` carries
-- the pipeline id as text so one column can hold either a pipeline id or a
-- flow name; `step_key` takes the stage's key, which is exactly the pointer
-- `stage_id` already denormalises.
update "pipeline_cases" as c
set "definition_ref" = c."pipeline_id"::text,
    "step_key" = s."key"
from "pipeline_stages" as s
where s."id" = c."stage_id"
  and (c."definition_ref" is null or c."step_key" is null);

alter table "pipeline_cases"
  drop constraint if exists "pipeline_cases_definition_kind_check";
alter table "pipeline_cases"
  add constraint "pipeline_cases_definition_kind_check"
  check ("definition_kind" in ('pipeline', 'flow'));

-- The invariant that lets both shapes share one table without either being
-- able to rot into the other. A pipeline case must carry its pipeline and its
-- stage; a flow case must carry neither, and must carry the two fields that
-- replace them.
alter table "pipeline_cases"
  drop constraint if exists "pipeline_cases_definition_shape_check";
alter table "pipeline_cases"
  add constraint "pipeline_cases_definition_shape_check"
  check (
    (
      "definition_kind" = 'pipeline'
      and "pipeline_id" is not null
      and "stage_id" is not null
    ) or (
      "definition_kind" = 'flow'
      and "pipeline_id" is null
      and "stage_id" is null
      and "definition_ref" is not null
      and "step_key" is not null
    )
  );

-- `pipeline_cases_pipeline_case_key_uq` is (pipeline_id, case_key), and NULLs
-- are distinct in a Postgres unique index — so it silently stops constraining
-- flow cases. This is its counterpart: one case per (company, flow, case key).
create unique index if not exists "pipeline_cases_flow_case_key_uq"
  on "pipeline_cases" ("company_id", "definition_ref", "case_key")
  where "definition_kind" = 'flow';

create index if not exists "pipeline_cases_definition_idx"
  on "pipeline_cases" ("company_id", "definition_kind", "definition_ref");

-- Say it in the catalogue too, so anyone reading the live schema (psql \d+,
-- an agent introspecting, a future migration author) learns it without
-- opening the TypeScript.
comment on column "pipeline_cases"."definition_kind" is
  'Which process definition owns this case''s steps: pipeline (stages) or flow (typed YAML nodes).';
comment on column "pipeline_cases"."definition_ref" is
  'Pipeline id as text for definition_kind=pipeline; flow name for definition_kind=flow.';
comment on column "pipeline_cases"."step_key" is
  'Authoritative current-step pointer. Stage key or flow node id — the same kind of thing.';
comment on column "pipeline_cases"."stage_id" is
  'Denormalised convenience for pipeline-defined cases; moves with step_key. NULL for flow-defined cases.';

comment on column "issues"."flow_name" is
  'DERIVED FROM CASE (pipeline_cases.definition_ref where definition_kind=flow). Mirror only; removed when the flow front-end is retired — execution-substrate.md §6 step 5.';
comment on column "issues"."flow_node_id" is
  'DERIVED FROM CASE (pipeline_cases.step_key). Mirror only; removed when the flow front-end is retired — execution-substrate.md §6 step 5.';
comment on column "issues"."flow_status" is
  'DERIVED FROM CASE (terminal_kind plus the coordinator''s in-flight status). Mirror only; removed when the flow front-end is retired — execution-substrate.md §6 step 5.';
comment on column "issues"."flow_run_id" is
  'Flow runtime state, mirrored alongside the case; removed when the flow front-end is retired — execution-substrate.md §6 step 5.';
comment on column "issues"."flow_started_at" is
  'DERIVED FROM CASE (pipeline_cases.created_at). Mirror only; removed when the flow front-end is retired — execution-substrate.md §6 step 5.';
comment on column "issues"."flow_advanced_at" is
  'DERIVED FROM CASE (pipeline_cases.updated_at). Mirror only; removed when the flow front-end is retired — execution-substrate.md §6 step 5.';
comment on column "issues"."flow_executor_agent_id" is
  'Flow runtime state, mirrored alongside the case; removed when the flow front-end is retired — execution-substrate.md §6 step 5.';
