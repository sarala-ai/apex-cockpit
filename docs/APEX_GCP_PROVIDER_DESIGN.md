# §5 Execution runners — design (local driver + `apex-gcp` remote provider)

Migration doc §5 (`docs/APEX_TOWER_MIGRATION.md`) is the least-mapped slice and
explicitly asks for design time before code. This is that design. It's grounded
in the fork's actual plugin contract (mapped) and apex's actual CLI/middleware
(verified against source).

## 1. Decomposition — local ≠ remote

Our staged `runner.ts` has two runners; they map to **two different fork seams**,
not one plugin:

| Our runner | Fork seam | Why |
|---|---|---|
| `LocalRunner` (`apex run` as a local subprocess) | the fork's **built-in `local` driver** | Local execution is "run a command on this host." The fork already does that; `apex run` is just the command. No plugin needed. |
| `RemoteRunner` (stub) | a **new `apex-gcp` sandbox-provider plugin** | Remote GCP execution (provision compute, sync workspace, run apex there, tear down) is genuinely new — the actual §5 work. |

This matches the migration doc verbatim: *"LocalRunner's subprocess-dispatch logic
ports directly into the local-equivalent path; RemoteRunner becomes the actual new
work once we need remote GCP execution."* So **`apex-gcp` is remote-only**; the
local path rides the fork's existing `local` driver.

## 2. The contract `apex-gcp` implements

A sandbox provider is a plugin declaring `environmentDrivers: [{ driverKey:
"apex-gcp", kind: "sandbox_provider", configSchema }]` in its manifest, running in
a worker process. The host discovers it via registry scan
(`server/src/services/plugin-environment-driver.ts:72` `resolvePluginSandboxProvider
DriverByKey`) when an `environments` row has `driver: "sandbox"`, `config.provider:
"apex-gcp"`. The 11 RPC handlers (`packages/plugins/sdk/src/define-plugin.ts:298-360`,
params/results in `packages/plugins/sdk/src/protocol.ts:554-648`):

- `onEnvironmentValidateConfig` — validate projectId/region/SA before persist.
- `onEnvironmentProbe` — auth to GCP, check quota, no-op create/delete smoke test.
- `onEnvironmentAcquireLease` → `PluginEnvironmentLease { providerLeaseId, metadata, expiresAt }` — provision or reuse the GCP compute; `providerLeaseId` = instance name.
- `onEnvironmentResumeLease` — reconnect to an existing instance by lease id.
- `onEnvironmentRealizeWorkspace` → `{ cwd, metadata }` — clone/sync the repo on the instance, return the remote working dir.
- `onEnvironmentExecute(params)` → `PluginEnvironmentExecuteResult { exitCode, signal, timedOut, stdout, stderr, metadata }` — **run `apex run <wf> --output json` on the instance, capture output.**
- `onEnvironmentReleaseLease` / `onEnvironmentDestroyLease` — stop/suspend (if `reuseLease`) or force-delete.
- interactive-setup handlers — not needed (skip; only if `supportsInteractiveSetup`).

## 3. Decision 1 — GCP backend: **persistent GCE instance + `reuseLease`**

Options: Cloud Run **job** (ephemeral, one-shot) vs Compute Engine **instance**
(persistent).

**Chosen: GCE instance, `reuseLease: true`, one per environment.** Rationale:
- A ticket runs a **multi-stage pipeline** (spec → plan → execute) — several apex
  invocations that share a **workspace + local checkpoint/state**. A persistent
  instance keeps that warm; a Cloud Run job is torn down after each command, cold-
  starting and losing the workspace every stage.
- The provider contract is built for this — `AcquireLease`/`RealizeWorkspace`/
  `ReleaseLease` with lease reuse is exactly the persistent-target lifecycle.
- Cost mitigation: remote is **opt-in per environment** (local is the dev default);
  `ReleaseLease` **stops** (not deletes) the instance when idle, `DestroyLease`
  deletes. Auto-stop after idle TTL via `expiresAt`.

**Cloud Run job is deferred**, not rejected — it's the right target later for a
fully-detached, single-shot workflow run (no agent loop, no shared workspace).

## 4. Decision 2 — apex CLI delivery: **pre-baked `apex-base` image, version-pinned**

Options: install apex per-lease vs pre-bake into the instance image.

**Chosen: a versioned `apex-base` image with the apex CLI pre-installed.**
- Built from the **private Sarala AR** using the same keyring/gcloud auth path as
  CI and `run-tower.sh` (`keyrings.google-artifactregistry-auth` + ADC).
- **Version attribution:** image tag tracks the apex release — build arg
  `APEX_VERSION=X.Y.Z` → `pip install apex-platform==X.Y.Z` → image tagged
  `apex-base:X.Y.Z`. The environment's `config.apexVersion` selects the tag, so a
  remote run is reproducible against a known apex.
- Per-lease install is rejected: it re-auths to the AR and re-installs on every
  instance boot (slow, more failure surface). Pre-bake once.
- Where it's built: apex-tower's build pipeline (it owns the tower runtime), NOT
  the apex repo (apex publishes the *package*; the tower composes the *image*).

## 5. Remote auth — attached service account, NOT forwarded user creds

This is the credential-boundary point from the dev-container discussion, made
concrete. The GCE instance runs with an **attached GCP service account** (its own
identity) — the tower does **not** forward the operator's `gcloud` creds into it.
The instance's apex uses ADC from the attached SA to touch GCP + pull nothing at
runtime (apex is pre-baked). This is the "sandbox gets its own short-lived scoped
identity" pattern; the operator's local gcloud stays on the operator's machine and
is only used for the **local** driver path.

## 6. JSON contract the `run` path must emit  (→ the apex enhancement)

`apex` already supports `--output json` at the group level (`apex_cli.py:44,93`),
honored richly by `apex state` and `apex validate`. The gap: the **run path** must
emit a structured result the provider can parse into `metadata` and the cockpit can
render. Target shape (to implement in apex, then depend on here):

```json
{
  "status": "succeeded | failed | no-op",
  "exitCode": 0,
  "workflow": "deploy-fastapi-cloudrun",
  "mode": "plan | apply",
  "plan": { "create": 3, "update": 1, "delete": 0 },
  "resources": [ { "id": "...", "action": "create", "type": "..." } ],
  "errors": [ { "code": "...", "message": "..." } ]
}
```

`exitCode` alone gates pass/fail; the rest drives the Ops surface (§3) — plan-diff,
changed resources, run status. **This is the one apex-side change §5 blocks on.**

## 7. Streaming bridge

Contract mismatch: `onEnvironmentExecute` returns a **buffered** result; our cockpit
wants **live** stdout (our `LocalRunner.run(task, onData)` streams per-chunk). Bridge:
stream `apex run` stdout over the instance transport (SSH `-T` / exec stream) into
the host, forwarding chunks to the existing case/workspace log surface, and still
return the final buffered `{exitCode, stdout, stderr}` for the record. The JSON
result (§6) is emitted on a separate fd or as the final stdout line so streaming
(human log) and structured result (machine) don't collide.

## 8. Build order

1. **Local path first** — wire the pipeline's execute step to the fork's built-in
   `local` driver running `apex run … --output json`; port `LocalRunner`'s spawn/
   stream/result-map. Unblocks end-to-end runs on the dev host now.
2. **apex `run --output json`** — the §6 enhancement, in the apex repo, released +
   pinned.
3. **`apex-base` image** — §4, built + pushed, version-pinned.
4. **`apex-gcp` plugin** — §2 contract, remote GCE lifecycle, against the image.
5. **CompanyEnvironments UI** — expose `apex-gcp` as a sandbox provider choice
   (`ui/src/pages/CompanyEnvironments.tsx` already renders provider config from the
   manifest `configSchema` — likely zero new UI).

## 9. Open questions

- One instance per **environment** or per **active ticket**? Start per-environment
  (simpler quota story); revisit if concurrent tickets contend.
- Workspace: fresh git clone per lease, or persist + `git fetch` delta? Start fresh;
  optimize with metadata-tracked last-synced commit if clone latency bites.
- Idle-stop TTL default (cost vs warm-start) — start 30 min, tune.
