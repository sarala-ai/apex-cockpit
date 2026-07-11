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

**What `apex-gcp` is (scope correction):** a **general GCP agent-execution
environment**, NOT an apex-workflow dispatcher. `onEnvironmentExecute` runs
arbitrary commands — the whole agent workload (git, edit, build, test, coding-agent
actions) runs *in this one sandbox*. What makes it "apex" is the **image**
(`apex-base`, §4): the apex CLI + toolchain are pre-baked, so the infra-executing
stage can call `apex run` there alongside everything else. Restricting execution to
workflows would split the agent's work across two execution planes and defeat the
point of an isolated environment. `apex run --output json` (§6) is the structured-
output contract for *that one command*, not the definition of the environment.

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
- `onEnvironmentExecute(params)` → `PluginEnvironmentExecuteResult { exitCode, signal, timedOut, stdout, stderr, metadata }` — **generic command execution.** Runs whatever the pipeline/agent dispatches in the sandbox (git, build, test, the coding agent's shell actions) — `apex run` is just the command the *infra-executing* stage issues, not the provider's only job. See §6a.
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

Scope (§6a): this is the structured-output contract for the **`apex run` command
specifically** — one of the many commands the environment executes (§2) — so the
cockpit can render infra results. Every *other* command the sandbox runs is plain
stdout/exit-code; only apex needs a machine-readable result.

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

## 8a. Naming — `apex-gcp`, and the two "GCP"s

Locked name: **`apex-gcp`** = an *apex-flavored GCP execution environment* (the
`apex-base` image on GCP compute — where apex runs). Do NOT confuse with apex's
internal `providers/gcp` (in the apex CLI), which is apex *targeting* GCP resources
(what apex provisions). Same cloud, different layers:

| Name | Layer | Means |
|---|---|---|
| apex `providers/gcp` (apex repo) | IaC target | what apex provisions on GCP |
| `apex-gcp` (this plugin) | execution host | where apex/agent work runs |

Not `apex-cloud`: it's GCP-only today (tower is GCP-first), "cloud" reads like a
hosted-apex SaaS, and a future AWS host would be a sibling `apex-aws` provider
(per-backend, matching the fork's `modal`/`e2b`/`exe-dev` convention) rather than a
cloud-switch inside one fat provider.

## 8b. Scope boundaries — what `apex-gcp` is NOT

- **apex is not a plugin.** `apex-gcp` is a plugin (kind: `sandbox_provider`); apex
  itself is the **substrate** — a CLI baked into the `apex-base` image, invoked via
  the generic execute path like git/node. It maps to no fork plugin "kind" and
  shouldn't. The plugin gives the tower a *place* to run apex; it isn't apex.
- **apex's own docker/GCP integration tests do NOT collapse into the plugin.** They
  stay in apex's repo CI (testing apex against dockerized/emulated GCP). Coupling
  the tower's runtime plugin to apex's test harness would point the dependency arrow
  backwards. What legitimately shares is the **`apex-base` image artifact** — apex CI
  and `apex-gcp` can validate/build on the same image — not the execution machinery.
- **Docker-in-the-environment is an image capability, not a scope expansion.** If
  agent work inside the sandbox needs docker (apex workflows that shell docker, or
  tests), the instance/image provides it (§4) — that's not a reason to absorb apex's
  test suite.

## 9. Open questions

- One instance per **environment** or per **active ticket**? Start per-environment
  (simpler quota story); revisit if concurrent tickets contend.
- Workspace: fresh git clone per lease, or persist + `git fetch` delta? Start fresh;
  optimize with metadata-tracked last-synced commit if clone latency bites.
- Idle-stop TTL default (cost vs warm-start) — start 30 min, tune.
