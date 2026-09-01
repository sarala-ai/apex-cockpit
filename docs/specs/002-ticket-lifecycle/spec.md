# Spec 002 — apex-tower: Ticket Lifecycle Engine (the plumbing)

**Status**: Draft · **Created**: 2026-07-10 · **Milestone**: v0.2 (first vertical slice)

## Purpose

Build the **plumbing** that carries one real engineering ticket, on a real Sarala repo
(bloom / finpilot / apex itself), all the way through the disciplined-agent loop —
**ticket → spec → plan → execute → PR** — with a **human-in-the-loop (HITL) gate at
every stage**, everything observable inside apex-tower.

This is the vertical slice that proves the whole thesis narrowly before it's widened.
Every later ambition (epics, greenfield assembly-order, remote execution, multi-source
tickets) is an extension of *this* pipeline, not a different system. We prove it on one
ticket we're doing anyway, dogfooded, then widen.

## The two seams that define the architecture (founder, Jul 10)

1. **Control plane is local. Execution can relocate.** apex-tower's cockpit, HITL gates,
   working store, and monitoring **never leave the desktop**. The *only* thing that may
   move to the cloud is agent **execution** — onto a provisioned instance/container —
   behind an `ExecutionRunner` seam. Local vs remote is a config flip, not a rewrite.
2. **Ticket source is pluggable; GitHub Issues is the source of truth.** Engineering
   tickets live in GitHub Issues (where the PR / git-history / CI join lives). apex-tower
   mirrors them into a thin local working store for coordination + the ephemeral
   spec/plan artifacts. The store is engineering-shaped (ticket→spec→plan→tasks→PR→CI),
   **not** business-shaped. Other sources (repo/SpecKit files, Linear) slot behind the
   same `TicketSource` interface later.

## The make-or-break discipline (do not violate)

The orchestrator is a **thin decider**, not a smart mega-prompt. The LLM decides *what*
(which task, what order, when to escalate to a gate). Each *process step* (build, test,
lint, deploy) is a **deterministic APEX workflow**, not a prompt. **LLM at the edges
(plan / decide / review); determinism in the core (execute / verify).** This is APEX's
"deterministic core, intelligent edges" applied to the ticket lifecycle. Get this right
and the system is durable; make the orchestrator clever and it's a house of cards.

## Durable vs ephemeral (resolves the doc-rot concern)

- **Ephemeral** (work-orders, disposable after merge): the spec and plan artifacts. They
  steer the agents, then get out of the way. Archived, never maintained as truth.
- **Durable** (source of truth): **code + tests** in git (tests are the executable spec
  that fails loudly when it drifts) + the **PR** (joins issue → exact diff) + a promoted
  **APEX workflow** where the work generalizes (capture-promote / compound engineering).

## Pipeline — explicit states, HITL gates are first-class

Each stage is a named state. A **gate** state *blocks* until a human decision
(`approve` / `edit` / `reject`) arrives from the UI. Every gate decision is recorded to
the audit ledger. States:

```
 ingested                       ticket mirrored from source into the working store
   → specifying                 spec coordinator agent (one-shot) drafts the spec
   → gate:spec_review     [HITL] approve / edit / reject the spec
   → planning                   plan coordinator agent (one-shot) drafts plan + tasks
   → gate:plan_review     [HITL] approve / edit / reject the plan + task order
   → executing                  orchestrator dispatches deterministic APEX workflows
                                 per task (build, test, lint) on the ExecutionRunner
   → gate:pr_review       [HITL] review the diff + green tests, approve merge
   → done                       PR merged; spec/plan archived; workflow promoted if reusable
   (any stage) → failed         surfaced with the failing step + logs (never silent)
```

- **Coordinator agents** (spec, plan): Claude Agent SDK **streaming** so the UI can watch
  tokens/thinking/tool-calls live and interrupt. One-shot per stage ("one-time
  coordinators") — they produce an artifact and exit; they are not long-lived.
- **Execution**: the orchestrator (thin decider) walks the approved task list and, per
  task, invokes an APEX workflow through the `ExecutionRunner`. No raw agent shells out
  to `gcloud`/`git` directly for infra steps — those go through APEX (APEX-first).
- **Every stage streams** its progress (agent stream, APEX run, gate state) to the cockpit;
  tokens/cost come from SigNoz as in spec 001.

## Seams (interfaces this milestone must land)

- `TicketSource` — `list()`, `get(id)`, `updateStatus(id, status)`, `openPR(...)`.
  Impl this milestone: `GitHubIssuesSource` (via `gh` / GitHub MCP). SoT = GitHub.
- `ExecutionRunner` — `run(step): stream`. Impl this milestone: `LocalRunner`
  (subprocess / node-pty on the desktop). `RemoteRunner` (provisioned GCP
  instance/container) is a documented later impl behind the same interface.
- `WorkingStore` — engineering-shaped persistence for the pipeline (ticket, stage,
  spec artifact, plan artifact, tasks, gate decisions, PR link, CI status). Start with a
  thin local store (SQLite/JSON); Paperclip's tables may back it later without touching
  callers.
- `CoordinatorAgent` — wraps the Agent SDK streaming call for a stage; returns the
  artifact + the live stream handle for the UI.
- `Orchestrator` — the thin decider: given an approved plan, dispatch APEX workflows per
  task via `ExecutionRunner`, advance pipeline state, raise gates.

## v0.2 walking-skeleton — definition of done

Prove the spine on **one real ticket** end-to-end:
1. Pick a real open GitHub issue on a Sarala repo; `GitHubIssuesSource` mirrors it into
   the working store (`ingested`).
2. Spec coordinator drafts a spec artifact; UI shows the live stream; **you approve at
   `gate:spec_review`**.
3. Plan coordinator drafts plan + ordered tasks; **you approve at `gate:plan_review`**.
4. Orchestrator runs at least one task as a **deterministic APEX workflow** through
   `LocalRunner` (e.g. build + test), streaming to the cockpit. A failing step surfaces
   loudly (never silent success).
5. A PR is opened linking back to the issue; **you approve at `gate:pr_review`**.
6. The whole run is visible in the cockpit (stage timeline + per-stage stream + token/cost)
   and every gate decision is in the audit ledger.

## Non-goals for this milestone (explicit — no silent scope creep)

- **Greenfield epic decomposition / assembly-order.** Hardest, least-deterministic part;
  this milestone is *single ticket*. Epics come after the single-ticket loop is solid,
  and will lean on HITL + capture-promote templates.
- **RemoteRunner.** Interface only; local execution proves the loop first.
- **Paperclip harvest.** The session-view rendering / kanban graft is a later graft onto
  these seams, not a prerequisite.
- **Auth / multi-user.** Local-first, single-user, sidecar binds localhost only.

## License & provenance posture

Unchanged from spec 001. Claude Agent SDK = Anthropic Commercial ToS (API-key; don't brand
as "Claude Code"). All UI/sidecar deps MIT/Apache. APEX invoked as a subprocess/CLI (its
own repo). No Vista private code — clean-room only.
```
