-- Give every already-running flow the case it should have had.
--
-- Five rows carry live flow state today (APE-1..5 on the APEX company) and no
-- pipeline case exists at all, which is exactly why this is the moment to do
-- it: the merge in 0164 will never again be this cheap
-- (docs/architecture/execution-substrate.md §6.1).
--
-- Idempotent by construction: an issue that already has a `work` link to a
-- flow-defined case is skipped, so re-running this changes nothing. Safe on a
-- database where the flow columns are all null: the WHERE clause selects
-- nothing and both statements are no-ops.
--
-- Only issues carrying BOTH a flow name and a node id qualify. A row with a
-- status but no node has no step to point at, and inventing one would put a
-- fiction into the authoritative pointer — such a row is left alone for a
-- human to look at rather than quietly repaired.

with candidate as (
  select
    i."id" as issue_id,
    i."company_id",
    i."flow_name",
    i."flow_node_id",
    i."flow_status",
    coalesce(i."identifier", i."id"::text) as case_key,
    i."title",
    coalesce(i."flow_started_at", now()) as started_at,
    coalesce(i."flow_advanced_at", i."flow_started_at", now()) as advanced_at
  from "issues" as i
  where i."flow_name" is not null
    and i."flow_node_id" is not null
    and not exists (
      select 1
      from "pipeline_case_issue_links" as l
      join "pipeline_cases" as c on c."id" = l."case_id"
      where l."issue_id" = i."id"
        and l."role" = 'work'
        and l."retired_at" is null
        and c."definition_kind" = 'flow'
    )
),
created as (
  insert into "pipeline_cases" (
    "company_id", "pipeline_id", "stage_id",
    "definition_kind", "definition_ref", "step_key",
    "case_key", "title", "version",
    "terminal_kind", "terminal_at",
    "created_at", "updated_at"
  )
  select
    c."company_id", null, null,
    'flow', c."flow_name", c."flow_node_id",
    c."case_key", c."title", 1,
    -- The flow vocabulary has six statuses; the case terminal has two. `done`
    -- maps across directly; `failed` is a case that ended without succeeding,
    -- which is what `cancelled` means here. `paused` is deliberately NOT
    -- terminal — a paused flow is waiting for a human, not finished.
    case c."flow_status" when 'done' then 'done' when 'failed' then 'cancelled' else null end,
    case when c."flow_status" in ('done', 'failed') then c."advanced_at" else null end,
    c."started_at", c."advanced_at"
  from candidate as c
  on conflict do nothing
  returning "id", "company_id", "case_key", "definition_ref"
)
insert into "pipeline_case_issue_links" ("company_id", "case_id", "issue_id", "role")
select created."company_id", created."id", candidate."issue_id", 'work'
from created
join candidate
  on candidate."company_id" = created."company_id"
 and candidate."case_key" = created."case_key"
 and candidate."flow_name" = created."definition_ref"
on conflict do nothing;
