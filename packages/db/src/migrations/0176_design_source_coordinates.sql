-- APEX-88 — the design lifecycle names WHERE DESIGN LIVES, never one repo.
--
-- `lifecycles.ts` hardcoded `sarala-ai/apex-design` in four places: the branch
-- command, the agent prompt, the acceptance contract and the merge workflow.
-- Seeded lifecycles are company-shared and carry no project, so that string is
-- the same anti-pattern APEX-38 removed for checks and deploys — a company
-- whose ticket entered the design lifecycle would push to somebody else's
-- design repository.
--
-- Two nullable columns, beside check_command / deploy_workflow, which already
-- established that a project workspace declares where its work happens.
--
-- HOW THE TWO COMBINE, and why there are two:
--   design_repo set    -> design lives in that repo (separate design repo).
--   design_repo null   -> design lives in THIS project's own repo (monorepo),
--                         derived from repo_url at resolution time.
--   design_path        -> folder within whichever repo won, e.g. 'product' or
--                         'design'. Null means the repository root.
-- A monorepo therefore declares only design_path; a split repo declares
-- design_repo and usually design_path too. Neither declared, and no repo_url
-- to fall back on, is a HOLD with an honest message — never a push to a
-- default that belongs to another company.
alter table "project_workspaces" add column if not exists "design_repo" text;
--> statement-breakpoint
alter table "project_workspaces" add column if not exists "design_path" text;
--> statement-breakpoint

-- Backfill the one workspace this was hardcoded for, so the behaviour on this
-- instance is unchanged by the generalisation. Guarded on the artifact path
-- the cockpit already discovered (`product/apex-platform.penpot`), so a
-- workspace an operator has already configured is left alone.
update "project_workspaces"
set "design_repo" = 'sarala-ai/apex-design',
    "design_path" = 'product',
    "updated_at" = now()
where "design_repo" is null
  and "design_path" is null
  and exists (
    select 1 from "projects" p
    where p."id" = "project_workspaces"."project_id"
      and p."name" = 'APEX Cockpit'
  );
