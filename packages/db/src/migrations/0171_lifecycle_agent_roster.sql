-- Wire the already-seeded lifecycle agent steps to the agents that execute
-- them (server/src/services/apex-agent-roster.ts).
--
-- WHY THIS IS DATA AND NOT ONLY CODE: `seedLifecyclePipelines` is idempotent by
-- (company_id, key) — it returns early when the pipeline row already exists. So
-- teaching the seeder to write `onEnter.agentKey` fixes every company seeded
-- from now on and NOTHING on an instance that already has the three lifecycles,
-- which includes the live one. Those stages would keep resolving their executor
-- by falling through to "the company's single assignable agent", silently, on a
-- board where the roster now exists precisely so that guess stops happening.
--
-- WHAT IS WRITTEN, and why both fields together:
--
--   `onEnter.agentKey`     — WHO executes the step.
--   `onEnter.permissions`  — the run-policy profile that agent runs under
--                            (server/src/apex/steps/run-policy.ts), which is
--                            the ONLY thing a step can say about blast radius.
--
-- They are written as a pair because separating them is how they drift: the
-- key without the profile leaves `derivePermissionPolicy` falling back to
-- `bounded` (its safe default — but the WRONG answer for the Specifier, which
-- must not be able to write a repo), and the profile without the key governs a
-- run commissioned against an agent nobody chose.
--
-- The pairs below are the same ones the seeder now emits, and they mirror
-- LIFECYCLE_DEFINITIONS' agent nodes exactly:
--
--   bug           / repro_fix   -> implementer       (bounded)
--   design-change / board_diff  -> design-engineer   (bounded)
--   feature       / spec        -> specifier         (read-only-broad)
--   feature       / tasks       -> implementer       (bounded)
--
-- IDEMPOTENT and NON-DESTRUCTIVE. The `onEnter.agentKey is null` guard means a
-- stage an operator has already pointed at a different agent is left alone —
-- this migration fills a gap, it does not assert ownership of the field. The
-- `type = 'agent'` guard means a stage that is not an agent step is never
-- touched even if it happens to share a key.

do $$
declare
  wiring record;
begin
  for wiring in
    select * from (values
      ('bug',           'repro_fix',  'implementer',     'bounded'),
      ('design-change', 'board_diff', 'design-engineer', 'bounded'),
      ('feature',       'spec',       'specifier',       'read-only-broad'),
      ('feature',       'tasks',      'implementer',     'bounded')
    ) as t(pipeline_key, stage_key, agent_key, profile)
  loop
    update "pipeline_stages" ps
    set "config" = jsonb_set(
          "config",
          '{onEnter}',
          ("config" -> 'onEnter')
            || jsonb_build_object(
                 'agentKey', to_jsonb(wiring.agent_key),
                 'permissions', jsonb_build_object('profile', wiring.profile)
               )
        ),
        "updated_at" = now()
    from "pipelines" p
    where p."id" = ps."pipeline_id"
      and p."key" = wiring.pipeline_key
      and ps."key" = wiring.stage_key
      and ps."config" -> 'onEnter' ->> 'type' = 'agent'
      and ps."config" -> 'onEnter' ->> 'agentKey' is null;
  end loop;
end $$;
