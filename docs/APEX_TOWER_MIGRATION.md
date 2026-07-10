# apex-tower migration (Paperclip fork → apex-tower)

**Decision (final):** this fork *is* apex-tower. Our clean-built apex-tower work
migrates **into** this tree; the old `sarala-ai/apex-tower` repo is retired; this
repo gets renamed `sarala-ai/paperclip → sarala-ai/apex-tower` once green.

## The key insight — Paperclip already has our concepts

The fork already ships pages that are analogs of what we hand-built. So the work is
mostly **rewiring their pages to our data (APEX workflows, our Org/Company/GCP,
our ticket source)** — NOT adding duplicate dockview panes.

| Our concept (hand-built) | Fork's existing analog | Migration action |
|---|---|---|
| Org / Company setup (`setup/`) | `ui/.../pages/Companies.tsx`, `Projects.tsx`; `companyId` tenancy | Rewire their Companies/Projects to our **Org (Sarala) → Company → GCP projects/repo** model + our `/setup` discovery (gcloud/gh). Keep their multi-tenancy DB scaffolding. |
| Ticket lifecycle (`pipeline/`) | `pages/Pipelines.tsx`, `ReviewQueue`, `Approvals` | Map our stages → their pipeline items; our **HITL gates** → their Approvals/ReviewQueue; our coordinators (Agent SDK) + APEX-workflow execution as the runner. |
| Observe token/cost | `pages/Costs.tsx` | Feed our SigNoz/OTel + APEX-run data into Costs. |
| Compounding loop (spec 003) | `pages/Learnings` (Pipelines) | Their Learnings is the compound-engineering surface — wire capture-promote into it. |
| Ticket source (GitHub Issues) | `pages/Issues.tsx` | Their Issues ↔ our `TicketSource` (gh). |
| Execution runners (Local/Docker/Remote) | `packages/adapter-utils` (execution-target: local/ssh/sandbox) + `packages/adapters/*` + `packages/plugins/sandbox-providers/*` | Use the fork's runners/adapters; our `runner.ts` (APEX-workflow dispatch) becomes one adapter/runner. |

## Where our code is staged (portable logic + reference)

- `server/src/apex/` — pipeline engine, setup (cloud/company discovery + stores),
  coordinators, runner, observe, exec/errors/config. **Framework-agnostic logic
  ports cleanly; `apex/index.ts` is the Fastify route reference to re-express as
  Express routes** in `server/src/routes/` / `realtime/`.
- `ui/src/apex/panes/` + `api.ts` — our panes, kept as **reference** for the
  data-flow when rewiring the fork's pages (they hit the same endpoints).
- `docs/specs/{001,002}` — our specs.

## Gut list (the org-chart / hiring metaphor — delete)

`ui/src/pages/OrgChart.tsx` (+ test), `components/ReportsToPicker.tsx`,
`components/GoalTree.tsx`, `lib/new-agent-hire-payload.ts`,
`lib/duplicate-agent-payload.ts`, CEO/hiring copy, and the `reportsTo` field on
agents (set/keep null). Remove the OrgChart route from `ui/src/App.tsx`.
Agents run with `reportsTo=null`; the metaphor is decorative.

## Reconciliation points (do in the build env)

1. **UI shell:** fork is **react-router pages** (not dockview). Either add a
   dockview route/page, or (preferred) fold our pane logic into the existing
   pages above. Our panes import `@/components/ui/{card,badge}` — the fork HAS
   these, fix the alias paths.
2. **Server:** fork is **Express** (not Fastify) + drizzle + embedded-postgres.
   Re-express `apex/index.ts` routes as Express routes; our stores (`JsonEntityStore`,
   `JsonWorkingStore`) can back onto drizzle later.
3. **node-pty:** not a server dep — add it if we keep the raw Terminal pane;
   otherwise agent execution uses the fork's `adapter-utils` runners.
4. **Tenancy:** rewire fork `companyId` → our Org/Company model.

## Build / verify (Docker + Postgres env)

```
cd paperclip
pnpm install
pnpm typecheck      # tsc — no DB needed; fixes alias/framework gaps in apex/
pnpm build          # full build
pnpm dev            # embedded-postgres + server + ui
```

## Rename / cutover (final step, once green)

1. Migrate + green build.
2. Archive `sarala-ai/apex-tower`; rename `sarala-ai/paperclip → sarala-ai/apex-tower`.
3. In the monorepo: repoint the `apex-tower/` submodule to the renamed repo; drop
   the `paperclip/` submodule.
