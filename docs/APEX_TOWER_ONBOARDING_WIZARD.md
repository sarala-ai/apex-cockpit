# apex-tower onboarding wizard — spec

A state-aware, local-first guided setup that runs on first login (or whenever
settings are missing). It **detects** what's present, **auto-runs** the steps that
have an API/APEX path, and **HITL-gates** the steps that need a human (consent,
console-only actions). Agent/Playwright-drivable and e2e-testable; reuses the
pipeline's gate/approval primitive.

## Principles

1. **Detect, don't ask.** apex-tower runs locally, so it can inspect the real
   environment (gcloud/gh/ADC, config, Secret Manager, DB, gateway `/health`) far
   more richly than a SaaS. The wizard is a *detector*, not a dumb form.
2. **Auto what's an API; guide what's human.** Scriptable steps run via APEX
   workflows / API — never by browser-driving a third-party console. Human steps
   (OAuth consent, console-only actions) are HITL gates.
3. **Automation stops at the gate.** Playwright / an agent may drive the wizard's
   own UI and the auto-steps, and pause at a gate — but it never auto-approves
   third-party consent. The gate *is* the automation/human boundary.
4. **Resumable + idempotent.** Every step re-reads state; re-running is safe.
5. **Reuses HITL gates.** A setup gate = the same Approvals/gate primitive as the
   ticket pipeline. Onboarding is a HITL pipeline — and the first dogfood of it.

## Detector — `GET /setup/state`

Returns the status of each prerequisite so the UI renders a live checklist:

```
{
  auth:        { gcloud, gh, adc: 'ok'|'missing'|'expired' },   // /setup/auth + adc probe
  org:         { present: bool, id? },                          // orgs table
  companies:   { count, ids[] },                                // companies under org
  scoping:     { orgBound: bool, companyBound: bool },          // cloud_scope_bindings
  oauthClient: { configured: bool },                            // gateway Google OAuth client
  gateway:     { reachable: bool },                             // apex-gateway /health
  mcpServers:  { registered: [names] },                         // gateway GET /gateways
}
```

## Step / gate state machine

Ordered steps; each = `{ detect, kind: 'auto'|'hitl', action|guidance, verify }`.

| # | Step | Kind | Action / gate |
|---|---|---|---|
| 1 | Local auth | auto-detect + **hitl** if missing | detect gcloud/gh/ADC; if missing, guide `gcloud auth login` (reauth banner) |
| 2 | Org "Sarala" | **auto** | create from discovered Google org (`/orgs`), or one click |
| 3 | Companies + GCP/repo scoping | **auto (UI)** | the Org/scoping component — bind projects/repos per scope (`/apex/scope/...`) |
| 4 | Google OAuth client | **auto (APEX) → hitl consent-screen** | APEX workflow provisions the client + Secret Manager secret; consent-screen config is the one console gate |
| 5 | Gateway up | **auto** | start/health-check apex-gateway |
| 6 | Register MCP servers | **auto** | `POST /gateways` for known servers (e.g. Google Workspace MCP) |
| 7 | Connect capability (per-user OAuth) | **hitl** | user does the one Google consent (incremental scopes on their SSO identity); broker stores the token; wizard detects + advances |
| 8 | Per-tool governance | **auto (UI)** | allowlist which federated tools a company/agent may use (the resolver applied) |

## HITL gate mechanics (pause / act / resume)

- **Human path:** the wizard renders the exact instruction + a deep link (pre-filled
  GCP console URL where possible) or a copy-paste `gcloud`/APEX command, then polls
  `GET /setup/state` until the step flips to done, and advances.
- **Agent/Playwright path (headed, user's session):** automation runs the auto-steps,
  halts at the gate (`page.pause()` / poll-for-completion), the human completes the
  real action in the same visible browser, automation resumes on detected completion.
- **Never:** auto-click a third-party consent screen.

## Testability

- **e2e (Playwright):** drive the wizard's auto-steps deterministically with the HITL
  gates *mocked* → regression coverage, no human needed. (Extends
  `tests/e2e/apex-setup-scoping.spec.ts`.)
- **Live:** real HITL only on actual runs.

## Build order

1. `GET /setup/state` detector.
2. **Org/scoping UI component** (step 3) — first real step; greens the skipped
   UI-render e2e.
3. Wizard shell (checklist + step/gate renderer) over the detector.
4. Steps 4–8 as the OAuth/gateway/governance work lands.
