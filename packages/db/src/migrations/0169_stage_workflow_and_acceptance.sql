-- The two missing members of a stage's step config — step 3 of the
-- execution-substrate merge (docs/architecture/execution-substrate.md §6).
--
-- Of the four step kinds a real execution plane needs
-- (workflow · check · agent · gate), a pipeline stage could express exactly
-- one: `onEnter: {type: run_routine}` commissions an agent. Two consequences,
-- both observed live rather than inferred:
--
--   * The zero-token escape hatch did not close the loop. A `process`-adapter
--     routine genuinely runs at zero tokens, but NOTHING READ THE RESULT: the
--     case did not move. A deterministic step modelled that way was a
--     write-only side effect.
--   * A stage had no acceptance contract, so a check became a stage an agent
--     visits and self-attests to — the exact inversion of the thesis. If a
--     deterministic step needs a language model to say it succeeded, the
--     platform's central claim is gone.
--
-- This migration is the storage half of closing both. It is deliberately
-- small: the stage config that declares a workflow entry and an acceptance
-- block is jsonb and needs no DDL at all. What DOES need DDL is the ledger
-- that records an entry step's OUTCOME, because that ledger was built assuming
-- every automation is a routine.

-- 1 · The automation ledger records workflow entries too.
--
-- Reusing `pipeline_automation_executions` rather than adding a parallel table
-- is the point: idempotency (case, automation, triggering event), retry,
-- generation and the `automation_executed` / `automation_failed` case events
-- already exist here and are already on the board. A workflow entry carries no
-- routine, so `routine_id` becomes nullable and `kind` says which shape a row
-- is; the shape check makes a half-populated row impossible in either
-- direction.
alter table "pipeline_automation_executions"
  add column if not exists "kind" text not null default 'routine';

alter table "pipeline_automation_executions" alter column "routine_id" drop not null;

alter table "pipeline_automation_executions"
  drop constraint if exists "pipeline_automation_executions_kind_check";
alter table "pipeline_automation_executions"
  add constraint "pipeline_automation_executions_kind_check"
  check ("kind" in ('routine', 'workflow'));

alter table "pipeline_automation_executions"
  drop constraint if exists "pipeline_automation_executions_shape_check";
alter table "pipeline_automation_executions"
  add constraint "pipeline_automation_executions_shape_check"
  check (
    ("kind" = 'routine' and "routine_id" is not null)
    or ("kind" = 'workflow' and "routine_id" is null)
  );

comment on column "pipeline_automation_executions"."kind" is
  'Which step kind this entry ran: routine (an agent step) or workflow (a deterministic APEX operation, zero tokens).';

-- 2 · Three event types the two new members write.
--
-- `acceptance_evaluated` is the SERVER's verdict on a stage's acceptance
-- contract — the evidence a later transition checks, exactly the way
-- `review_decided` is the evidence `assertLatestReviewApprovalStillCurrent`
-- checks. It carries the case version it was evaluated at, so a verdict cannot
-- outlive the work it was about.
--
-- `step_held` / `step_hold_cleared` are the PAUSE. A failed workflow entry
-- with no failure route, and a failed acceptance evaluation, both hold the
-- case where it is: the hold is a fact on the event log, and the transition
-- gate reads it. A hold is scoped to the stage and only counts from the case's
-- last entry into that stage, so re-entering a stage is a clean slate without
-- anyone having to remember to clear anything.
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
    'step_hold_cleared'
  ));
