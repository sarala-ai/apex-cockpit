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

## Task 1 status (UI typecheck)

`ui/src/apex/panes/*.tsx` + `api.ts` fixed to typecheck in-fork:
- All four panes imported `@/lib/api` (our old path, absent in the fork) — repointed
  to `@/apex/api` (fork's `@` alias resolves to `ui/src/*`, confirmed in
  `ui/tsconfig.json` / `ui/vite.config.ts`).
- `@/components/ui/{card,badge}` resolve as-is — the fork has both with matching
  exports (`Card/CardHeader/CardContent/CardTitle`, `Badge`).
- **Real gap found:** our panes call `<Badge variant="success|danger|info">` —
  semantic status variants that don't exist on the fork's shadcn `Badge`
  (`default/secondary/destructive/outline/ghost/link` only). Added
  `ui/src/apex/status-badge.tsx` (`StatusBadge`), a thin wrapper mapping our
  semantic names to the fork's `outline` variant + a color className, so the
  shared shadcn primitive is untouched. Swapped the semantic call sites in
  `ObservePane.tsx`, `PipelinePane.tsx`, `SetupPane.tsx` to `StatusBadge`; plain
  `variant="default"` badges (mode tag, repo tag) still use the fork's `Badge`.
- Verified: `pnpm --filter @paperclipai/ui typecheck` (`tsc -b`) exits 0 on a
  clean rebuild (removed `ui/tsconfig.tsbuildinfo` first), and
  `tsc -b --listFiles` confirms all 6 `ui/src/apex/**` files are included in the
  compile. `node_modules` were already installed in this environment so no
  `pnpm install` timebox was needed.
- **Not done (later slice, per this doc's plan):** `server/src/apex/*` stays
  un-ported — it's Fastify-shaped; the fork is Express. See the route-by-route
  mapping below for how each of its endpoints becomes an Express route.

## Task 2 — wiring plan (page → route → our logic → schema)

Goal: for the next (bigger) slice, rewire the fork's existing mature
pages/routes/schema to our data instead of adding new surface. This section is
the file-grounded map. All fork routes below are mounted under `/api` (see
`server/src/routes/index.ts`); our staged endpoints in `ui/src/apex/api.ts`
already assume that same `/api` prefix via the Vite dev proxy.

### 1. Org / Company setup

| | |
|---|---|
| **Fork pages** | `ui/src/pages/Companies.tsx` (list/create/switch company via `useCompany()` / `CompanyContext`), `ui/src/pages/CompanySettings.tsx` (name, budget, attachment limits, branding), `ui/src/pages/CompanyImport.tsx` (portability import/export — unrelated to our flow, skip), `ui/src/pages/CompanyEnvironments.tsx` (execution environments — see §5), `ui/src/pages/Projects.tsx` / `ProjectDetail.tsx` (project CRUD, budget, workspaces) |
| **Fork API client** | `ui/src/api/companies.ts` (`companiesApi`), `ui/src/api/companies-query.ts`, `ui/src/api/projects.ts` (`projectsApi`) — fully typed, react-query-wrapped; no need to reinvent, just point our Setup flow at these |
| **Fork routes** | `server/src/routes/companies.ts`: `GET/POST /companies`, `GET /companies/:companyId`, `PATCH /companies/:companyId`, `PATCH /companies/:companyId/branding`, `POST /companies/:companyId/archive`, `DELETE /companies/:companyId`. `server/src/routes/projects.ts`: `GET/POST /companies/:companyId/projects`, `GET/PATCH/DELETE /projects/:id`. |
| **Fork schema** | `packages/db/src/schema/companies.ts` (`companies`: id, name, budgetMonthlyCents/spentMonthlyCents, issuePrefix/issueCounter, brandColor — **no GCP/org fields**). `packages/db/src/schema/projects.ts` (`projects`: id, companyId FK, goalId FK, name, status, env jsonb, executionWorkspacePolicy jsonb — **`env` jsonb is the extension point for our GCP project/repo binding**). |
| **Our staged logic** | `server/src/apex/setup/company.ts` (Org/Company registry — our `Org`/`Company` types in `ui/src/apex/api.ts` lines 112-127), `server/src/apex/setup/cloud.ts` (gcloud/gh discovery: `gcpProjects`, `gcpOrgs`, `githubOrgs`, `githubRepos`, `setupAuth`) |
| **companyId tenancy** | No global middleware injects `companyId` — each route param is authorized per-request against `companyMemberships` (join table user↔company), checked in `server/src/middleware/auth.ts` (`companyMemberships.companyId` lookups ~L60-70, ~L180-210). Our Org layer sits **above** this: Org = Sarala-level grouping of `companies` rows; a `companies` row = one of our GCP-backed "Companies" (FinPilot/Bloom/APEX). No schema change needed for Org — it can be a thin new table (`orgs`) with `companies.orgId` FK, or (cheaper) a jsonb tag on `companies.metadata` if we don't need multi-org yet (we don't — single Org "Sarala"). |
| **Rewiring action** | (a) Add `gcpProjects: string[]` / `githubRepos: string[]` to `projects.env` jsonb (or a sibling `company_cloud_bindings` table if we want it queryable) — this is where our `Company.gcpProjects`/`githubRepos` (api.ts L120-127) land. (b) Port `setup/cloud.ts` discovery functions into a new `server/src/routes/apex-setup.ts` Express route mounted as `GET /setup/auth`, `/setup/gcp/projects`, `/setup/gcp/orgs`, `/setup/github/orgs`, `/setup/github/repos` (1:1 rename from our Fastify `apex/index.ts`). (c) Point `SetupPane.tsx` (once folded into `CompanySettings.tsx` or a new "Cloud" tab) at `companiesApi` for company CRUD + the new `/setup/*` routes for discovery — do not duplicate company CRUD. |
| **Gotcha** | `server/src/routes/cloud-upstreams.ts` + `packages/db/src/schema/cloud_upstreams.ts` is a **naming collision, not a reuse target** — it's Paperclip's own SaaS relay/push-runs concept, unrelated to GCP org/project discovery. Don't confuse the two when grepping. |

### 2. Ticket lifecycle pipeline + HITL gates → Approvals

| | |
|---|---|
| **Fork pages** | `ui/src/pages/Pipelines.tsx` (huge — pipeline board, stages, cases, drag-drop, review queue, `Learnings`/feedback voting all in one file), `ui/src/pages/Approvals.tsx` (pending/all tabs, `ApprovalCard`), `ui/src/pages/ApprovalDetail.tsx` |
| **Fork API client** | `ui/src/api/pipelines.ts`, `ui/src/api/cases.ts`, `ui/src/api/approvals.ts` |
| **Fork routes** | `server/src/routes/pipelines.ts` (huge, ~2000+ lines): pipeline CRUD (`/companies/:companyId/pipelines`), stage CRUD (`/pipelines/:pipelineId/stages`), transitions (`PUT /pipelines/:pipelineId/transitions`), case ingestion (`POST /pipelines/:pipelineId/cases`, `/cases/batch`), case transition (`POST /cases/:caseId/transition`), review (`POST /cases/:caseId/review`, `/companies/:companyId/review-cases`, `/review-cases/bulk`). `server/src/routes/approvals.ts`: `GET/POST /companies/:companyId/approvals`, `POST /approvals/:id/{approve,reject,resubmit}`. |
| **Fork schema** | `packages/db/src/schema/pipelines.ts`: `pipelines` (companyId, projectId, key, name, `enforceTransitions`), `pipelineStages` (pipelineId, key, name, **`kind` CHECK IN ('working','review','done','cancelled')**, position, config jsonb), `pipelineTransitions` (fromStageId→toStageId edges). `packages/db/src/schema/pipeline_cases.ts`: `pipelineCases` (companyId, pipelineId, stageId, caseKey, title, fields jsonb, workspaceRef jsonb, parentCaseId — supports our sub-task/Task breakdown). `packages/db/src/schema/approvals.ts`: `approvals` (companyId, type, requestedByAgentId/UserId, status, payload jsonb, decisionNote). |
| **Our staged logic** | `server/src/apex/pipeline/engine.ts` (stage machine), `types.ts` (`Stage` enum: ingested→specifying→gate:spec_review→planning→gate:plan_review→executing→gate:pr_review→done/failed), `ticket-source.ts` (GitHub Issues ingestion — genuinely new, fork has no GitHub linkage field on its internal `issues` table), `coordinator.ts`/`coordinator-agent-sdk.ts` (Agent SDK dispatch), `runner.ts` (APEX-workflow-as-subprocess `LocalRunner`; `RemoteRunner` stubbed for later), `store.ts` (`JsonEntityStore`/`JsonWorkingStore`) |
| **Rewiring action** | (a) **Our fixed `Stage` enum becomes one `pipelines` row + 8 `pipelineStages` rows** (kind mapping: `ingested/specifying/planning/executing`→`working`, `gate:*`→`review`, `done`→`done`, `failed`→`cancelled`) with `pipelineTransitions` encoding the linear happy path — this is config, not code; seed it once via `POST /companies/:companyId/pipelines` + stage/transition calls, no schema change. (b) Our `gate:*` stages map to `approvals` rows: when `engine.ts` advances a case into a `gate:` stage, create an `approvals` row (`type: 'pipeline_gate'`, `payload: {caseId, stage}`); `POST /approvals/:id/approve|reject` becomes our `GateDecision` (`approve`/`edit`/`reject`) — note fork's approve/reject is binary, our `edit` decision has no fork analog yet, needs a payload-level extension (e.g. `resolveApprovalSchema` body carrying an edited artifact body) or a bespoke case-review action instead of the generic Approvals surface. (c) `ticket-source.ts` becomes a new ingestion adapter that calls `POST /pipelines/:pipelineId/cases` (one case per GitHub issue) rather than a schema change. (d) `runner.ts`'s `LocalRunner`/`RemoteRunner` becomes an execution adapter registered alongside the fork's existing adapters (see §5) — case transition triggers dispatch, streamed output goes through the fork's existing case/workspace log surface instead of our raw `/pipeline/step` WebSocket. (e) Our `/pipeline/tickets`, `/pipeline/runs`, `/pipeline/ingest`, `/pipeline/decide` (api.ts L154-160) all fold into the fork's existing case/approval endpoints above — **no new Express routes needed for the pipeline itself**, only the GitHub ingestion adapter and the gate→approval bridge are new code. |
| **Compounding loop** | Fork's `Learnings` surface lives inside `Pipelines.tsx` (feedback voting, `groupWarningsByStage`, `LOW_TRUST_REVIEW_PRESET` from `@paperclipai/shared`) — our spec-003 capture-promote loop wires into this via the same case/review data rather than a separate store. |

### 3. Observe (token/cost)

| | |
|---|---|
| **Fork page** | `ui/src/pages/Costs.tsx` — tabs/cards for `costs/summary`, `costs/by-agent`, `costs/by-agent-model`, `costs/by-provider`, `costs/by-biller`, budgets, finance events, quota windows |
| **Fork API client** | `ui/src/api/costs.ts` (`costsApi`), `ui/src/api/budgets.ts` |
| **Fork routes** | `server/src/routes/costs.ts`: `POST /companies/:companyId/cost-events`, `GET /companies/:companyId/costs/{summary,by-agent,by-agent-model,by-provider,by-biller,by-project}`, `GET/PATCH /companies/:companyId/budgets*` |
| **Fork schema** | `packages/db/src/schema/cost_events.ts` (`costEvents`: companyId, agentId, issueId, projectId, provider, biller, model, inputTokens/outputTokens/cachedInputTokens, costCents, occurredAt) — **already has `provider`/`model`/token columns, this is a near-exact match for our token/cost shape**. `finance_events.ts` for non-LLM spend. |
| **Our staged logic** | `server/src/apex/observe.ts`: `getApexRuns()` (reads local `instances.json`), `getCiRuns()` (gh CLI), token/cost from SigNoz (our `/observe/tokens` — api.ts L149-152) |
| **Rewiring action** | (a) Our SigNoz/OTel token+cost pipeline should **write into `cost_events`** (one row per LLM call, `provider`/`model`/token columns already fit) instead of a parallel `/observe/tokens` endpoint — then `Costs.tsx` already renders it with zero new UI. (b) `getApexRuns()` (APEX workflow instance status) and `getCiRuns()` (GH Actions) have **no fork analog** — these become a new small Express route (`server/src/routes/apex-observe.ts`: `GET /observe/apex-runs`, `GET /observe/ci-runs`) ported near-verbatim from `server/src/apex/observe.ts`, surfaced as a new card/tab bolted onto `Costs.tsx` (or a sibling "Ops" tab) rather than a whole new page. |

### 4. Ticket source (GitHub Issues)

| | |
|---|---|
| **Fork page** | `ui/src/pages/Issues.tsx` — this is the fork's **internal agent work-item tracker** (infinite-scroll list, filters, labels), not a GitHub issues mirror |
| **Fork schema** | `packages/db/src/schema/issues.ts` — no `githubIssueNumber`/`externalUrl`/source field found; issues are fully internal, created by agents/users, not synced from GitHub |
| **Finding** | This is **not a rewire**, it's new integration surface. Our GitHub `TicketSource` (`ticket-source.ts`) doesn't map onto `Issues.tsx` — that page is really the fork's analog of *our internal Task/case tracking* (already covered by `pipeline_cases` in §2). The actual "ticket source" concept is narrower than the doc's original table implied: it's just the ingestion adapter in §2(c) (`POST /pipelines/:pipelineId/cases`), not a page-level rewire. Correcting the original table: drop the `Issues.tsx` mapping, fold ticket-source entirely into §2. |

### 5. Execution runners

| | |
|---|---|
| **Fork adapters** | `packages/adapters/{claude-local,codex-local,cursor-local,cursor-cloud,gemini-local,grok-local,opencode-local,pi-local,hermes,hermes-gateway,openclaw-gateway}` — coding-agent CLI adapters, not cloud infra adapters. `packages/plugins/sandbox-providers/{cloudflare,daytona,e2b,exe-dev,kubernetes,modal,novita}` — sandbox/VM providers for **agent execution environments**. |
| **Fork routes/schema** | `server/src/routes/environments.ts`: `GET/POST /companies/:companyId/environments`, `GET/PATCH/DELETE /environments/:id`, `POST /environments/:id/probe`. `packages/db/src/schema/environments.ts`: `environments` (name, **`driver`**: `local` \| `sandbox` \| (adapter-specific), `config` jsonb, `envVars` jsonb, `metadata` jsonb — generic enough to hold a GCP-backed driver's connection info without a schema change). |
| **Gap found** | **No GCP/Cloud Run/GKE sandbox provider exists** among the 7 `sandbox-providers/*` plugins (cloudflare/daytona/e2b/exe-dev/kubernetes/modal/novita) — `kubernetes` is generic K8s, not GKE-specific, and none shell out to `gcloud`/APEX. |
| **Our staged logic** | `server/src/apex/pipeline/runner.ts`: `LocalRunner` (subprocess `apex run <workflow>`), `RemoteRunner` (stubbed, GCP instance/container) |
| **Rewiring action** | Our `runner.ts` becomes a **new sandbox-provider plugin** (`packages/plugins/sandbox-providers/apex-gcp/` or similar) implementing whatever interface the existing 7 providers share (check `packages/adapter-utils` for the shared contract before writing it) — `LocalRunner`'s subprocess-dispatch logic ports directly into the `local`-equivalent path; `RemoteRunner` becomes the actual new work once we need remote GCP execution. This is the **least mapped area** — budget real design time here rather than treating it as a pure rewire. |

## Rename / cutover (final step, once green)

1. Migrate + green build.
2. Archive `sarala-ai/apex-tower`; rename `sarala-ai/paperclip → sarala-ai/apex-tower`.
3. In the monorepo: repoint the `apex-tower/` submodule to the renamed repo; drop
   the `paperclip/` submodule.
