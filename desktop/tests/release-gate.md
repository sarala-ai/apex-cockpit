# Desktop release gate

What `desktop/tests/` proves before a release, and what it deliberately
doesn't — read this before treating a green run as "ready to ship."

## Tier 1 — `offline.spec.ts` (`npm run test:e2e`)

No network, no credentials. Run on every change to `desktop/src/`.

Proves:
- The packaged app boots to a real window and renders the sign-in screen —
  not a blank/crashed window — when no board token is stored.
- The sign-in screen shows its "Sign in with APEX" affordance.
- `apex-desktop-config.json` is created with the documented defaults
  (`mode: "remote"`, the deployed cockpit URL) the first time it's read.
- A hand-edited config file (`mode`/`cockpitUrl`) is honored on the next
  launch — the operator's local-vs-remote override path works.
- The preload bridge (`window.apexDesktop`) exposes the full surface the
  cockpit renderer depends on: `getConfig`, `auth`, `token`, `cloudAuth`,
  `claudeConnect` (`start`/`submitCode`/`cancel`/`onState`),
  `workstation.report`, `runner`.
- `claudeConnect.start({})` with neither `orgId` nor `companyId` fails with
  an error, instead of silently spawning a broken ceremony.
- `workstation.report()` while signed out fails cleanly instead of throwing
  or hanging.

## Tier 2 — `authenticated.spec.ts` (`npm run test:e2e:auth`, gated)

Skips cleanly unless `APEX_DESKTOP_TEST_COCKPIT_URL` and
`APEX_DESKTOP_TEST_BOARD_TOKEN` are set to a real deployed cockpit and a
live board API token. Run before a release, against staging or prod.

Proves, with the app actually signed in:
- The cockpit loads for real (window URL matches the configured cockpit
  origin).
- `/setup` is reachable and renders its steps (`apex-setup-wizard`).
- The status bar shows the gcloud/GitHub/ADC prerequisite chips.
- The desktop app's launch-time workstation report actually reached the
  cockpit — `reportedAt` on `/api/setup/workstation-report` is recent. (This
  is the `source` signal that matters: the report was submitted with
  `source: "desktop"`, and a fresh `reportedAt` is the checkable proof it
  round-tripped — the GET response doesn't echo `source` itself, and the
  status bar's `title` tooltip only shows an aggregate
  `"reported by your workstation …"` string, not a per-item source.)
- The Claude session step shows the inline ceremony start button
  (`data-testid="claude-connect-start"`) when the org exists.

The `/setup` route sits behind `CloudAccessGate`, which in `authenticated`
deployment mode calls `/api/auth/get-session`. That endpoint accepts any
board actor, and the desktop app injects its Bearer token on every request
to the cockpit origin, so the gate passes without a cookie session. The
tier asserts the route renders rather than redirecting to `/auth`, which
is the symptom if that injection ever regresses.

## What no automated tier proves — needs a human, every release

These all require a real consent screen in a real browser session; none of
them can run headless or with a stored token:

- **Google SSO sign-in** — the desktop app's `auth:login` opens the system
  browser for the cli-auth challenge approval; Google's OAuth screen itself,
  and the approve-in-browser → return-to-app handoff, need a human click.
- **Anthropic consent** — the Claude subscription ceremony
  (`apex claude connect`) requires a human to open the Anthropic
  authorization URL, approve, and paste the code back into the app.
- **GitHub OAuth consent** — connecting GitHub inside the setup wizard opens
  a real GitHub authorization screen that needs a human approval.

A release is gated on: Tier 1 green, Tier 2 green (when the gated env is
available) or explicitly waived with a reason, and a human walking the three
consent flows above at least once against the release build.
