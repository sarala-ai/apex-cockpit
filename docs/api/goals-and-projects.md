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
