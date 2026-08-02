-- Pipelines gain the two step kinds only flows could run, and the runtime
-- state a parked step needs — step 4 of the execution-substrate merge
-- (docs/architecture/execution-substrate.md §6).
--
-- 0169 gave a stage the DETERMINISTIC half (`run_workflow` + a server-evaluated
-- `acceptance` contract). What a stage still could not express is the half that
-- costs something: a bounded AGENT step, and a GATE that carries a brief. Both
-- existed only in the flow coordinator, whose state lived in seven columns on
-- `issues`. The founder's decision is that those four typed lifecycles stop
-- being git YAML read through `apex flows show` and become database-backed
-- pipeline definitions; this migration is the storage half of that.
--
-- Nothing here is a second shape. Every column added is the pipeline case's
-- own version of something the issue mirror carried, moved to the row that is
-- now authoritative.

-- 1 · A pipeline IS a process definition, so it carries what one carries.
--
-- `version` and `ticket_type` came off the flow YAML header and are read by
-- the decision brief (which says "Approve a design change", not "approve
-- approval 4f3c…") and by whatever picks a lifecycle for a new ticket. Without
-- them the projection in server/src/apex/steps/process-definition.ts would
-- have to invent both, and an invented ticket type is a wrong headline on the
-- one screen a human actually reads.
alter table "pipelines"
  add column if not exists "version" text not null default '1.0',
  add column if not exists "ticket_type" text;

comment on column "pipelines"."ticket_type" is
  'The kind of work this process is for (chore, bug, design-change, feature). NULL for a pipeline that is not a ticket lifecycle.';

-- 2 · The runtime state of a step that is IN FLIGHT.
--
-- A `workflow` or `check` step finishes inside the call that started it, so
-- the case never has to remember anything about it. An `agent` step and a
-- `gate` step do not: one is waiting on a run somewhere else, the other on a
-- human. The flow front-end kept exactly this on the issue
-- (`flow_status` / `flow_run_id` / `flow_executor_agent_id`) and it is the
-- reason a second writer could close APE-5 as `done` while its gate still read
-- `waiting_gate`. Here it lives on the case row, beside the `version` that
-- makes a compare-and-set meaningful, and there is one writer.
--
-- Deliberately NOT a copy of the flow status vocabulary. Flows had six
-- statuses conflating "where the case is" with "what is happening to it"; the
-- case already answers the first (`step_key`, `terminal_kind`). This column
-- answers only the second, and only when the answer is "something is in
-- flight" — NULL means the case is idle at its step, which is the common case
-- and needs no word for itself.
alter table "pipeline_cases"
  add column if not exists "step_status" text,
  add column if not exists "step_run_id" uuid,
  add column if not exists "step_executor_agent_id" uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pipeline_cases_step_run_id_fkey'
  ) then
    alter table "pipeline_cases"
      add constraint "pipeline_cases_step_run_id_fkey"
      foreign key ("step_run_id") references "heartbeat_runs" ("id") on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'pipeline_cases_step_executor_agent_id_fkey'
  ) then
    alter table "pipeline_cases"
      add constraint "pipeline_cases_step_executor_agent_id_fkey"
      foreign key ("step_executor_agent_id") references "agents" ("id") on delete set null;
  end if;
end $$;

alter table "pipeline_cases" drop constraint if exists "pipeline_cases_step_status_check";
alter table "pipeline_cases"
  add constraint "pipeline_cases_step_status_check"
  check ("step_status" is null or "step_status" in ('waiting_agent', 'waiting_gate'));

comment on column "pipeline_cases"."step_status" is
  'What is in flight at the current step: waiting_agent, waiting_gate, or NULL (idle at the step). Not a second location pointer — step_key and terminal_kind own that.';
comment on column "pipeline_cases"."step_run_id" is
  'The bounded agent run this case is parked on, when step_status = waiting_agent.';
comment on column "pipeline_cases"."step_executor_agent_id" is
  'The agent commissioned for the current agent step — sticky across rework rounds so a step is redone by whoever did it.';

-- The sweep's working set: parked cases, and only those. A partial index
-- because the overwhelming majority of rows are idle and must not be paid for.
create index if not exists "pipeline_cases_step_status_idx"
  on "pipeline_cases" ("company_id", "step_status", "updated_at")
  where "step_status" is not null;

-- The completion hook's lookup: a finished run must find its case in one
-- probe, not a scan.
create index if not exists "pipeline_cases_step_run_idx"
  on "pipeline_cases" ("step_run_id")
  where "step_run_id" is not null;

-- 3 · The automation ledger records all three kinds.
--
-- Same reasoning 0169 gave for admitting `workflow`: idempotency (case,
-- automation, triggering event), retry, generation and the
-- `automation_executed` / `automation_failed` events already live here, and a
-- parallel table per kind would duplicate every one of them. Only `routine`
-- carries a routine id; the shape check keeps a half-populated row impossible
-- in every direction rather than only the two 0169 knew about.
--
-- 0169's `workflow` becomes `run`. A step is named for WHO EXECUTES it, and
-- "workflow" named what it happened to target — which is why the same value
-- also had to mean "check". The rename is done here rather than left as an
-- alias because an alias is how two vocabularies start
-- (docs/architecture/process-definition.md §2a).
alter table "pipeline_automation_executions"
  drop constraint if exists "pipeline_automation_executions_kind_check";
alter table "pipeline_automation_executions"
  drop constraint if exists "pipeline_automation_executions_shape_check";

update "pipeline_automation_executions" set "kind" = 'run' where "kind" = 'workflow';

alter table "pipeline_automation_executions"
  add constraint "pipeline_automation_executions_kind_check"
  check ("kind" in ('routine', 'run', 'agent'));

alter table "pipeline_automation_executions"
  add constraint "pipeline_automation_executions_shape_check"
  check (
    ("kind" = 'routine' and "routine_id" is not null)
    or ("kind" in ('run', 'agent') and "routine_id" is null)
  );

comment on column "pipeline_automation_executions"."kind" is
  'Who executed this entry step: routine or agent (a model, costs tokens) or run (the machine, costs nothing).';

-- 4 · The events a parked step writes.
--
-- `gate_opened` is the approval being created — the moment attention starts
-- being spent, which is what "waiting 3 hours" on the brief is measured from.
-- `step_waiting` / `step_resumed` are the agent step's park and wake. They are
-- NOT `step_held` / `step_hold_cleared`: a hold is a REFUSAL to advance that a
-- transition gate reads, while waiting is the ordinary in-flight state. Naming
-- them the same would make "the case cannot move" and "the case has not
-- finished moving" indistinguishable on the board, and the first needs a human
-- while the second needs patience.
alter table "pipeline_case_events" drop constraint if exists "pipeline_case_events_type_check";
alter table "pipeline_case_events"
  add constraint "pipeline_case_events_type_check"
  check ("type" in (
    'ingested',
    'updated',
    'claimed',
    'lease_released',
    'lease_expired',
    'transitioned',
    'transition_forced',
    'transition_suggested',
    'suggestion_resolved',
    'review_decided',
    'conversation_opened',
    'issue_linked',
    'issue_unlinked',
    'automation_executed',
    'automation_failed',
    'automation_retry_requested',
    'automation_effects_retired',
    'automation_retry_dispatched',
    'blockers_set',
    'blockers_resolved',
    'children_terminal',
    'upstream_drift',
    'drift_acknowledged',
    'acceptance_evaluated',
    'step_held',
    'step_hold_cleared',
    'gate_opened',
    'step_waiting',
    'step_resumed'
  ));
