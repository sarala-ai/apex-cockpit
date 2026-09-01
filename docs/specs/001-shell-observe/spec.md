# Spec 001 — apex-tower: Shell + Observe Pane

**Status**: Draft · **Created**: 2026-07-10 · **Milestone**: v0.1 (walking skeleton)

## What apex-tower is

The cockpit / control-plane for **disciplined agent development** — the human command
surface where you assemble agents and workflows, spawn and supervise Claude Code
sessions (Zed-ACP style), watch what they cost and touch, and observe the GCP
resources and MCP servers they operate on. One React UI over four eventual panes:
**Observe · Sessions/Playground · MCP + Agent registry · GCP resources**.

It is **not** the coding agent (that's Claude Code) and **not** the engine (that's
APEX). It is mission control. Positioning: *"APEX is Paperclip for engineers."*
Paperclip keeps the business/org-chart view; apex-tower takes the engineering view.

### Family
- **APEX** — deterministic workflow engine + GCP tooling + state (existing, `sarala-ai/apex`)
- **apex-gateway** — MCP gateway/registry (ContextForge fork, shrunk; its admin UI is absorbed here)
- **apex-tower** — this project: the cockpit UI + a local process sidecar
- **"Forge"** — apex-tower's future workflow/agent-assembly pane (repurposed from Paperclip's agent-builder UI)

## Base decision

Fork **paperclipai/paperclip** (MIT, Node+React, adapters for Claude Code/Codex/Cursor/bash)
at a **pinned commit**. The work is mostly **subtraction** — strip the company / org-chart /
governance framing — plus adding our panes. Paperclip already gives us ~70% of the spine:
the Node server + React UI, the Claude Code adapter (external-CLI session hosting = the
Zed-ACP-style vision), embedded persistence, and a cost/budget model we reuse for Observe.

> **v0.1 pragmatic note**: rather than fork-and-strip in the first milestone, v0.1 builds a
> **clean walking skeleton** with the same stack choices as Paperclip (so harvesting its
> adapter + cost code later is a graft, not a rewrite). Forking-and-stripping Paperclip's
> full tree is milestone v0.2. This keeps the first running artifact small and legible.

## Architecture (v0.1)

```
┌──────────── apex-tower UI (Vite + React + shadcn/ui + dockview) ───────────┐
│  dockview panes:  [ Observe ]  [ Terminal (PTY) ]   (more panes later)     │
└───────────────┬────────────────────────────┬──────────────────────────────┘
                │ WebSocket (PTY stream)      │ REST/WS (metrics, records)
        ┌───────▼─────────────────┐   ┌───────▼───────────────────────────┐
        │  Sidecar (Node/Fastify) │   │  Observe data sources             │
        │  · node-pty spawn/stream│   │  · SigNoz (Claude Code native OTel│
        │    (Claude Code, shells,│   │    token/cost/tool-events + traces│
        │     dev servers, builds)│   │  · APEX state: gs://sarala-apex-  │
        │  · reads ~/.claude JSONL│   │    state (instances, plans)       │
        │    session history      │   │  · ci_runs (gh) recent runs       │
        └─────────────────────────┘   └───────────────────────────────────┘
```

- **UI**: Vite + React + TypeScript + shadcn/ui (copy-in, we own the code) + **dockview** (dockable panes) + **@xterm/xterm v6** (terminal rendering) + **@xyflow/react** (later, for run DAGs). All MIT.
- **Sidecar**: a thin Node service (Fastify + `ws` + **node-pty**). Owns local process lifecycle: spawn a PTY, stream stdout/stdin over WebSocket, start/stop, list. This is the one genuinely-custom spine piece (crib: Paperclip's Claude Code adapter, `anthropics/claude-agent-sdk-demos`, Crystal's worktree pattern). Same process later hosts the Claude Agent SDK streaming-input bridge.
- **Observe backend**: **SigNoz** (MIT core) via `docker-compose`, ingesting Claude Code's native OTel (`CLAUDE_CODE_ENABLE_TELEMETRY=1` → OTLP: `token.usage`, `cost.usage`, `tool_decision`/`tool_result` events, beta traces). apex-tower queries SigNoz's API for the Observe pane; it does not re-implement metrics storage.

## Observe pane (v0.1 scope)

The Observe pane answers **"what did my agents do, and what did it cost?"** — the on-brand
first pane (token-spend = infra-spend). Three cards, degrade gracefully if a source is absent:

1. **Token & cost** — from SigNoz (Claude Code OTel metrics): today's token usage + USD cost, by session; a small time-series. If SigNoz has no data yet, show an empty state with the one-line enable instruction.
2. **Recent APEX runs** — from `apex state list` / the GCS state bucket: last N workflow instances (name, status, timestamp, apply/plan). Read-only.
3. **Recent CI runs** — from `gh run list` (via the sidecar shelling `gh` or apex `ci` server): last N GitHub Actions runs with conclusion. Read-only.

Non-goals for v0.1: alerting, the Sessions/Playground pane, MCP/agent registry, GCP resources pane, the Forge assembly UI, auth. Those are later specs.

## v0.1 "walking skeleton" — definition of done

A running local artifact that proves the spine end-to-end:
1. `docker compose up` brings SigNoz up locally; a documented env snippet points Claude Code's OTel at it.
2. `pnpm dev` (or npm) runs the Vite UI + the sidecar together.
3. The UI renders a **dockview** layout with two panes: **Terminal** and **Observe**.
4. **Terminal pane spawns a real PTY** through the sidecar over WebSocket — you can run `claude`, a shell, a dev server — proving spawn/stream works (the load-bearing architectural risk).
5. **Observe pane renders all three cards** against live sources where present, graceful empty states where not (SigNoz may be empty on first run — that's an accepted pass).
6. README documents: prerequisites, the SigNoz compose, the OTel env, how to run, and the architecture diagram above.

## Verification

- Terminal: spawn a PTY, type a command, see output; stop it cleanly.
- Observe: with APEX state synced (bucket exists) and a `gh` login, the runs cards populate; the token card populates once Claude Code has emitted OTel to the local SigNoz.
- No secrets committed; sidecar binds localhost only (local-first, single-user).

## License & provenance posture

Everything adopted is MIT/Apache: Vite, React, shadcn/ui, dockview, @xterm/xterm, @xyflow/react, SigNoz core, node-pty, Fastify. The Claude Agent SDK (later) is Anthropic Commercial ToS (API-key only; don't brand as "Claude Code"). Paperclip (base, later milestone) is MIT — fork from a pinned commit; keep attribution. apex-gateway's ContextForge lineage stays Apache-2.0 with NOTICE intact. Avoid (verified traps): Open WebUI (branding license), claudecodeui/opcode (AGPL), Dify (logo clause), Steampipe core (AGPL — subprocess-only if used).

## Later specs (not this milestone)
- 002 — Sessions / Playground pane (Claude Agent SDK streaming bridge; ~/.claude history; worktree-per-session)
- 003 — MCP + Agent registry pane (absorbs apex-gateway admin: servers, agents, prompts) + catalog-in-git (server.json)
- 004 — GCP resources pane (APEX gcp_inventory + scheduled health checks + Cloud SQL/D2 deployment state)
- 005 — Forge: workflow/agent assembly (repurpose Paperclip builder UI)
- 006 — Tool-call audit ledger (FastMCP middleware → SQLite → GCS; the novel custom piece)
- 007 — Evals pane (seed from apex-eval agent-task harness; prompt/model evals later)
- 008 — Tauri desktop wrap (same web app; tray, shortcuts, native FS)
