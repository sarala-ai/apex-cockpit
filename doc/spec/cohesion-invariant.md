# Cohesion Invariant — Spine · Provenance · Lineage

> **STATUS: FROZEN** — Ratified Aug 21 2026 (APEX-146). This is an invariant,
> not a living doc. Changes require a new invariant ticket with a governance
> gate.

---

## The invariant

Every component artifact produced by the APEX platform must satisfy all four
conditions simultaneously:

| # | Condition | Short name |
|---|-----------|------------|
| 1 | The artifact is keyed to a `heartbeat_runs.id` that is reachable from `apex.run.id` on its correlation trace | **Spine** |
| 2 | The artifact carries a producer identity (kind + id + version) | **Provenance** |
| 3 | The artifact emits at least one lineage edge to what it was derived from | **Lineage** |
| 4 | The artifact passed through the single governance gate before being committed | **Gate** |

"Artifact" means any durable entity that a component ticket produces: a skill
version, an eval lesson, an eval amendment, an issue, or a cost event.

---

## Seam questions (the EVALUATOR's three scoring dimensions)

When an EVALUATOR agent scores a component ticket's output against this
invariant, it answers exactly three questions:

### Q1 — Is the artifact on the spine?

**Pass**: `artifact.run_id` (or its DB column equivalent) is a non-null UUID
that joins to a row in `heartbeat_runs` whose `apex.run.id` OTel attribute
matches the run that produced the artifact.

**Fail**: the `run_id` column is null, or the UUID does not join to any
`heartbeat_runs` row, or the heartbeat run belongs to a different company.

### Q2 — Does the artifact carry provenance?

**Pass**: `producer_kind` is one of `agent | user | workflow`, `producer_id`
is non-null, and `producer_version` is non-null.

**Fail**: any of the three provenance fields is null.

### Q3 — Does the artifact emit a lineage edge?

**Pass**: at least one row exists in `lineage_edges` for this company where
`to_kind` = the artifact's entity kind and `to_id` = the artifact's UUID.

**Fail**: no `lineage_edges` row points at this artifact.

---

## Scoring

| Q1 | Q2 | Q3 | Score |
|----|----|----|-------|
| ✓  | ✓  | ✓  | 100 — fully cohesive |
| ✓  | ✓  | ✗  | 66 — lineage gap |
| ✓  | ✗  | ✓  | 66 — provenance gap |
| ✗  | ✓  | ✓  | 66 — off-spine |
| ✓  | ✗  | ✗  | 33 — only spine |
| ✗  | ✗  | ✗  | 0 — fully incoherent |

A score below 66 is a **blocker** — the artifact must not be marked `done`.
A score of 66 is a **warning** — the ticket is shippable with a noted gap.
A score of 100 is the **target** — the only state that satisfies the DoD.

---

## Definition of Done (DoD clause)

Each component ticket's DoD includes the following acceptance clause,
evaluated against the invariant above:

```
APEX-146 cohesion gate:
  [ ] artifact.run_id joins heartbeat_runs (Q1)
  [ ] producer_kind / producer_id / producer_version are non-null (Q2)
  [ ] lineage_edges contains ≥1 edge where to_id = artifact.id (Q3)
  [ ] cohesion score ≥ 66; score = 100 is required to mark done
```

---

## Schema materialisation (cockpit DB — APEX-146 slice)

This contract is materialised by migration `0176_cohesion_lineage_provenance`
and the Drizzle schema changes that accompany it. The contract EXTENDS the
existing spine; it never rewrites existing columns.

### Off-spine column additions (nullable, additive)

| Table | New column | Purpose |
|-------|------------|---------|
| `issues` | `origin_run_id` promoted text → uuid FK | spine join |
| `company_skills` | `run_id uuid` | spine join |
| `company_skills` | `producer_kind text` | provenance |
| `company_skills` | `producer_id uuid` | provenance |
| `company_skills` | `producer_version text` | provenance |

### New standalone tables

**`lineage_edges`** — one row per derivation edge, keyed to `run_id` so
cross-DB pivots use only the spinal `apex.run.id`. Extends the `issue_relations`
pattern; zero changes to existing tables.

**`eval_lessons`** — terminal nodes: insights extracted from evaluation runs.
Carry provenance and a lineage edge to the eval run they were derived from.

**`eval_amendments`** — terminal nodes: corrections to prior decisions.
Carry provenance and a lineage edge to the subject entity they amend.

---

## Constraint: three DBs, no cross-DB joins

The platform runs three separate Postgres databases:

| DB | Owner |
|----|-------|
| cockpit | apex-cockpit (this repo) |
| gateway | hermes-gateway |
| apex-eval | apex-eval |

Each DB gets its own `lineage_edges` table. Cross-DB correlation is done
exclusively via the shared `run_id` (= `apex.run.id` in OTel) — never via a
cross-DB FK. The cockpit DB is the spine anchor; gateway and apex-eval
migrations are out of scope for APEX-146 and will be separate tickets.

---

## Reference implementation

- **Spine**: `server/src/observe/contract.ts` → `Spine` (already exists)
- **Provenance**: `server/src/observe/contract.ts` → `Provenance` (added by APEX-146)
- **Lineage**: `server/src/observe/contract.ts` → `LineageEdge` (added by APEX-146)
- **SpineMixin** (apex-eval): the evaluator reference implementation that
  attaches `apex.run.id` to every eval span — the canonical cross-DB pivot point.
