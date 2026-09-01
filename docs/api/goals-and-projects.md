---
title: Goals and Projects
summary: Goal hierarchy and project management
---

Goals define the "why" and projects define the "what" for organizing work.

## Goals

Goals form a hierarchy: company goals break down into team goals, which break down into agent-level goals.

An **initiative** (`level: "initiative"`) is the object the product-engineering
model turns on. It carries a budget, a stop condition, an assumption sheet and
— only when there is a genuine question — a hypothesis, and it ends with a
`closure`.

### List Goals

```
GET /api/companies/{companyId}/goals
```

### Get Goal

```
GET /api/goals/{goalId}
```

### Create Goal

```
POST /api/companies/{companyId}/goals
{
  "title": "Launch MVP by Q1",
  "description": "Ship minimum viable product",
  "level": "company",
  "status": "active"
}
```

### Update Goal

```
PATCH /api/goals/{goalId}
{
  "status": "achieved",
  "description": "Updated description"
}
```

Valid `level` values: `company`, `initiative`, `team`, `agent`, `task`.

Valid `status` values: `planned`, `active`, `achieved`, `cancelled`.

### Initiatives

These fields are accepted only when `level` is `initiative`; sending them on
any other goal is a 400.

| Field | Meaning |
|---|---|
| `hypothesis` | The question being tested. Absent on most initiatives. |
| `budget` | Free text — time or money (`"two weeks"`, `"40k"`). |
| `stopCondition` | What would make us stop, written before work begins. |
| `assumptions` | `[{ id, statement, type, status, evidence? }]` — `type` is `technical` / `regulatory` / `commercial` / `operational`, `status` is `untested` / `retired` / `blocked`. |
| `validationCriteria` | The pre-registered bars, each with a named reader and a date. See below. |
| `provenance` | `{ kind: "confirmed" \| "inferred", source? }` — how this record came to exist. |
| `closure` | How it ended: `validated` / `stopped` / `revised` / `expired`. |
| `closureReason` | The evidence behind the closure. |

```
POST /api/companies/{companyId}/goals
{
  "title": "Proactive alerts",
  "level": "initiative",
  "hypothesis": "Households act on proactive alerts",
  "budget": "two weeks",
  "stopCondition": "extraction error over 10%, or under 30% second-alert engagement",
  "assumptions": [
    { "id": "a1", "statement": "Extraction is accurate enough", "type": "technical", "status": "untested" }
  ]
}
```

**`derivedStatus` (read-only).** Every GET of an initiative returns
`derivedStatus`, computed from the projects joined to it: `planned` (nothing
decomposed) · `active` (anything completed or in progress) · `on_hold`
(everything live is held) · `delivered` (every live project completed) ·
`cancelled` (all projects cancelled). It is never accepted on a write, and
`PATCH` refuses a `status` on an initiative — status is a consequence of the
projects, `closure` is the human decision. Non-initiative goals return
`derivedStatus: null`.

### Validation criteria

`stopCondition` is prose: it cannot carry a reader or a date, and it cannot be
marked hit or missed. `validationCriteria` is the part that can.

| Field | Meaning |
|---|---|
| `id`, `statement` | What must be true. |
| `measure` | What is observed. Free text — there is no metric DSL. |
| `threshold` | The bar (`"≥80%"`). Free text; the comparison is a human judgement. |
| `window` | When it is measured, for a reader. Free text. |
| `ownerUserId` / `ownerAgentId` | **The named reader. At least one is required.** |
| `reviewDate` | ISO date. **Required.** |
| `status` | `pending` / `hit` / `missed` / `never_registered`. |
| `reviewedAt`, `reviewNote` | Filled when someone reports against it. |
| `surfacedAt` | Stamped by the review sweep; makes surfacing idempotent. |

A criterion with no owner, or no `reviewDate`, is rejected at write time. That
rejection is the point: *"a criterion without a named reader and a date is not
a criterion. It is a wish with a number in it."*

`never_registered` is the honest import — an initiative reconstructed from
history saying, on the record, that criteria were never written. There
`ownerUserId`, `ownerAgentId` and `reviewDate` are **forbidden**, not merely
optional: supplying them would retro-fit a decision nobody made.

**The monitor.** A sweep (`APEX_CRITERION_REVIEW_HOURS`, default 1h, `0`
disables) finds `pending` criteria whose `reviewDate` has arrived and surfaces
each one **once** — a board approval of type `criterion_review` for a user
owner, an agent wakeup for an agent owner — logging `goal.criterion_surfaced`.

### Report against a criterion

```
POST /api/goals/{id}/criteria/{criterionId}/report
{
  "status": "hit",
  "reviewNote": "84% over 1,412 turns in apex-eval"
}
```

Only `hit` and `missed` are accepted — a report is a one-way statement about
what was seen, and a criterion cannot be returned to `pending`. It stamps
`reviewedAt`, closes the inbox item the sweep raised, and logs
`goal.criterion_reported`. Reporting against a `never_registered` criterion is
a 400: nothing was registered to measure.

## Projects

Valid `status` values: `backlog` (not started), `planned`, `in_progress`,
`on_hold` (valid, decided, not now), `completed`, `cancelled`.

Projects group related issues toward a deliverable. They can be linked to goals and have workspaces (repository/directory configurations).

### List Projects

```
GET /api/companies/{companyId}/projects
```

### Get Project

```
GET /api/projects/{projectId}
```

Returns project details including workspaces.

### Create Project

```
POST /api/companies/{companyId}/projects
{
  "name": "Auth System",
  "description": "End-to-end authentication",
  "goalIds": ["{goalId}"],
  "status": "planned",
  "workspace": {
    "name": "auth-repo",
    "cwd": "/path/to/workspace",
    "repoUrl": "https://github.com/org/repo",
    "repoRef": "main",
    "isPrimary": true
  }
}
```

Notes:

- `workspace` is optional. If present, the project is created and seeded with that workspace.
- A workspace must include at least one of `cwd` or `repoUrl`.
- For repo-only projects, omit `cwd` and provide `repoUrl`.

### Update Project

```
PATCH /api/projects/{projectId}
{
  "status": "in_progress"
}
```

## Project Workspaces

Workspaces link a project to a repository and directory:

```
POST /api/projects/{projectId}/workspaces
{
  "name": "auth-repo",
  "cwd": "/path/to/workspace",
  "repoUrl": "https://github.com/org/repo",
  "repoRef": "main",
  "isPrimary": true
}
```

Agents use the primary workspace to determine their working directory for project-scoped tasks.

### Manage Workspaces

```
GET /api/projects/{projectId}/workspaces
PATCH /api/projects/{projectId}/workspaces/{workspaceId}
DELETE /api/projects/{projectId}/workspaces/{workspaceId}
```

## Proposals — reviewing structured objects

A design file renders at a gate. A code diff renders at a gate. A set of
proposed records did not, which is why reviewing a reconstructed initiative
tree had no home in the product.

A **proposal** carries typed records of one `kind`, each with its own
provenance (`confirmed` with a source, or `inferred`). Records are corrected
**on the proposal** — no live object is touched — and the whole set goes to one
approval gate. Approval materialises; rejection and request-changes write
nothing.

```
GET   /api/proposal-kinds                          # kinds + their review columns
POST  /api/companies/{companyId}/proposals
GET   /api/proposals/{id}
PATCH /api/proposals/{id}/records/{ref}            # correct one row in place
POST  /api/proposals/{id}/submit                   # open the single gate
GET   /api/proposals/{id}/export.csv               # read the set offline
```

A record with `targetId` UPDATES that object on approval; one without CREATES.
This is what makes a proposal usable against a board that already has objects
on it — a reconstruction is mostly corrections.

`PATCH .../records/{ref}` merges `fields`, so correcting one cell never
requires resending the rest of the row.

The gate is an ordinary approval: `POST /api/approvals/{id}/approve` (which
materialises), `.../request-revision` (which returns the set to the proposing
agent with the reason attached), `.../reject`.

Adding a kind is a registration — a materialiser in
`server/src/services/proposals.ts` and a renderer in
`ui/src/components/proposal-renderers/` — and touches neither the routes nor
the review surface.

## Goals as CSV

For reading a lot of rows offline. **Not** the review path.

```
GET  /api/companies/{companyId}/goals/export.csv?level=initiative
POST /api/companies/{companyId}/goals/import.csv[?apply=true]
```

Export is UTF-8 with a BOM (so Excel opens it correctly), ordered by
`created_at` so two exports diff cleanly, with read-only columns marked in
their header.

Import is the secondary bulk-edit path, dry-run unless `?apply=true`:

- a row **with** an `id` updates; a row **without** one creates
- **a blank cell leaves the stored value unchanged**; to clear a field, put
  `--` in it
- `derived_status` and the `projects` column are computed — a cell that
  disagrees is reported as a notice, never applied and never silently dropped
- row errors carry their file line number and do not abort the batch
