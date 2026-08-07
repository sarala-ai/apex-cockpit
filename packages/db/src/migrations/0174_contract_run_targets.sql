-- APEX-38 — lifecycle check/deploy steps name the CONTRACT, never the tool.
--
-- The seeded lifecycles hardcoded `pytest tests/unit` at their check stages
-- and the `cloud_run_deploy` workflow at their deploy stages, regardless of
-- the project's stack. A Node project fails those checks on TOOL MISMATCH,
-- not on the work. The fix is a `contract` run target — `checks_pass` /
-- `deployed` — resolved at dispatch time from the project's own workspace
-- config (server/src/apex/pipeline/contract-targets.ts).
--
-- 1 · Where the resolution reads from: two nullable columns beside
-- `setup_command`, which already established that a project workspace declares
-- host commands.
alter table "project_workspaces" add column if not exists "check_command" text;
--> statement-breakpoint
alter table "project_workspaces" add column if not exists "deploy_workflow" text;
--> statement-breakpoint

-- 2 · Rewrite the ALREADY-SEEDED lifecycle stages. `seedLifecyclePipelines`
-- is idempotent by (company_id, key) and returns early on existing rows, so
-- teaching the seeder to emit contract targets fixes every company seeded
-- from now on and nothing that exists — the same reason 0171 wired agentKey
-- as data. Guarded by the exact hardcoded tool each stage shipped with: a
-- stage an operator has already retargeted is left alone.
do $$
declare
  wiring record;
begin
  for wiring in
    select * from (values
      ('bug',     'tests',       'command',  'pytest',           '{"type":"contract","contract":"checks_pass"}'::jsonb),
      ('feature', 'task_checks', 'command',  'pytest',           '{"type":"contract","contract":"checks_pass"}'::jsonb),
      ('bug',     'deploy',      'workflow', 'cloud_run_deploy', '{"type":"contract","contract":"deployed"}'::jsonb),
      ('feature', 'deploy',      'workflow', 'cloud_run_deploy', '{"type":"contract","contract":"deployed"}'::jsonb)
    ) as t(pipeline_key, stage_key, target_type, shipped_tool, contract_target)
  loop
    update "pipeline_stages" ps
    set "config" = jsonb_set("config", '{onEnter,target}', wiring.contract_target),
        "updated_at" = now()
    from "pipelines" p
    where p."id" = ps."pipeline_id"
      and p."key" = wiring.pipeline_key
      and ps."key" = wiring.stage_key
      and ps."config" -> 'onEnter' ->> 'type' = 'run'
      and (
        (wiring.target_type = 'command'
          and ps."config" -> 'onEnter' -> 'target' ->> 'tool' = wiring.shipped_tool)
        or
        (wiring.target_type = 'workflow'
          and ps."config" -> 'onEnter' -> 'target' ->> 'workflow' = wiring.shipped_tool)
      );
  end loop;
end $$;
