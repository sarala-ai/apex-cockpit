# APEX-35 Spec — Cockpit MCP Server, Run-Scoped Identity

## Scope

One streamable-HTTP MCP server mounted at `/mcp` on the cockpit server process (same process as UI + REST API). Three consumer classes share a single identity model: dispatched agent runs (JWT bearer), chat-panel ask-mode runs (JWT bearer, draft-write capability set), and external hosts (OAuth 2.1 + PKCE user tokens). Enforcement lives in the REST service layer — MCP is a thin veneer. Every tool call writes an audit row.

---

## Task Breakdown and Acceptance Criteria

### T1 — MCP server scaffold

Mount `/mcp` on the cockpit server using the MCP SDK's streamable-HTTP transport. Register tool skeletons (no logic yet). Self-register with the APEX gateway (`POST /gateway/registry`) on boot via idempotent default registration.

**Acceptance criteria (machine-checkable):**
- `GET /healthz` (or equivalent startup probe) still passes with `/mcp` mounted.
- `POST /mcp` with an MCP `initialize` request returns a valid `InitializeResult` (protocol version, server info, capabilities).
- The gateway registry contains a `cockpit-mcp` entry after server boot (query `GET /gateway/registry` or DB probe).
- No separate server process or loopback HTTP call to our own REST layer exists in the scaffold.

---

### T2 — Run-JWT auth middleware

Extend `agent-auth-jwt.ts` (or add a sibling `mcp-run-jwt.ts`) to mint and verify `cockpit-mcp`-audience tokens. Add claims: `issue_id`, `case_id`, `project_id`, and `granted_capabilities: string[]` from the lifecycle node's run policy. Mount a middleware on the `/mcp` route that extracts the bearer token, verifies it, and attaches run identity to request context.

**Acceptance criteria:**
- A valid `cockpit-mcp`-audience JWT is accepted; run identity (agentId, companyId, issueId, grantedCapabilities) is reachable in tool handler context.
- A token with `aud: "paperclip-api"` (wrong audience) is rejected with HTTP 401.
- An expired token is rejected with HTTP 401.
- A request with no `Authorization` header is rejected with HTTP 401.
- A token signed with a wrong key is rejected with HTTP 401.

---

### T3 — Capability enforcement + audit log

Add a per-tool capability gate: each tool declares the capability it requires. Before the handler runs, check whether `grantedCapabilities` includes that capability; if not, return an MCP error with HTTP 403. After every tool call (success, deny, or handler error) write an audit row: `(runId | userId, agentId | null, companyId, tool, requiredCapability, outcome, timestamp)`.

**Acceptance criteria:**
- A tool call with a JWT that lacks the required capability returns HTTP 403 and an MCP error without executing the handler.
- A permitted call succeeds (2xx) and the handler logic runs.
- Both calls write an audit row: the denial row has `outcome: "denied"`, the success row has `outcome: "ok"`.
- Audit rows are queryable by `runId` or `userId`.
- Handler panics/throws still write an audit row with `outcome: "error"`.

---

### T4 — Board API read tools

Implement `listIssues`, `getIssue`, `listComments`, `getHeartbeatContext`. Each tool calls the service layer **in-process** (no loopback HTTP). Required capability: `board:read`.

**Acceptance criteria:**
- Each tool returns JSON matching the shape of the equivalent REST endpoint.
- A curl/MCP-client probe calling `listIssues` with a valid JWT returns issues for the JWT's `company_id`.
- No outbound HTTP to `localhost` or `127.0.0.1` appears in server logs during a tool call (verified by log inspection or test spy).
- Results are company-scoped: a JWT for company A cannot retrieve issues for company B.

---

### T5 — Board API write tools

Implement `createComment`, `createIssue`, `updateIssue`. Required capability: `board:write`. Write tools must reject requests where `grantedCapabilities` includes only `board:read`.

**Acceptance criteria:**
- A JWT with `granted_capabilities: ["board:write", "board:read"]` can call all write tools.
- A JWT with only `board:read` gets HTTP 403 on write tool calls and succeeds on read tool calls (same JWT, same session).
- `createComment` persists the comment and returns the created comment object.
- `createIssue` creates the issue under the JWT's `company_id` and returns the issue object.
- `updateIssue` applies field changes and returns the updated issue object.

---

### T6 — Chat-panel draft-write toolset auto-restriction

When an MCP session carries a JWT where `granted_capabilities` contains `draft:write` (the chat-panel capability marker) but NOT `board:write`, the `tools/list` response is automatically attenuated to the draft-write set: all read tools, `createComment` (draft-only variant), `createIssue` (draft status only), `createDocument` (proposals). Excluded from this set: `updateIssue` with status transitions to approved/done/cancelled, and any pipeline-edit tools.

**Acceptance criteria:**
- A `tools/list` call with a draft-write JWT omits pipeline-edit tools and status-transition write tools from the response.
- A `tools/list` call with a full-write JWT returns all tools.
- The attenuation is enforced at the tool-list level, not just at the handler level (a draft-write token cannot call an excluded tool even by name).
- The human never receives or holds an MCP credential (no credential field exposed in the chat-panel UI).

---

### T7 — OAuth 2.1 + PKCE external-host flow

Implement authorization endpoint and token endpoint on the cockpit server. Validate PKCE (`S256` only). Enforce RFC 8707 resource indicator (`resource` parameter must be the cockpit MCP URI). Resulting tokens are user-scoped and attenuated at the gateway. Register as an OAuth capability in the gateway.

**Acceptance criteria:**
- A PKCE authorization-code flow completes end-to-end: `GET /oauth/authorize` → consent redirect → `POST /oauth/token` → access token returned.
- An authorization request without `code_challenge` or with `code_challenge_method: plain` is rejected with `invalid_request`.
- A token request with a wrong `code_verifier` is rejected with `invalid_grant`.
- A request without a valid `resource` indicator is rejected with `invalid_target`.
- The resulting access token is accepted by the MCP `/mcp` auth middleware and produces a user-scoped identity (no `runId`, populated `userId`).
- An external host (Claude Code or curl-simulated PKCE flow) can call `tools/list` after completing the flow.

---

### T8 — local_trusted adapter: auto-mint cockpit-mcp JWT at dispatch

At run dispatch time, when the adapter type is `local_trusted`, mint a `cockpit-mcp`-audience JWT from the lifecycle node's run policy capability grants and inject it as `PAPERCLIP_MCP_TOKEN` into the run environment. No static API keys in adapter env.

**Acceptance criteria:**
- A run dispatched by `local_trusted` has `PAPERCLIP_MCP_TOKEN` set in its environment.
- The token is a valid `cockpit-mcp`-audience JWT accepted by the MCP server.
- The token's `granted_capabilities` matches the capability set declared in the lifecycle node's run policy for that run.
- No `PAPERCLIP_API_KEY`-equivalent static key or shared secret appears in adapter env for MCP access.
- `local_trusted` never auto-grants anonymously: audit rows always carry a `runId` (never null identity).

---

### T9 — OTel: nested traces, no duplicate root spans

Every tool call through the gateway must produce exactly one root span in apex-eval. The gateway injects `traceparent`, the MCP handler continues the trace, and service calls are in-process, so all spans nest under one root. The apex-eval receiver is the single OTLP export target (config from APEX-26 instance config).

**Acceptance criteria:**
- A single tool call through the gateway produces exactly 1 root span in apex-eval (e2e probe asserts `rootSpanCount === 1`).
- The trace contains at least 3 spans: gateway, mcp-handler, service (nested, not parallel roots).
- `traceparent` header is propagated from the gateway request into the MCP tool handler (log or span attribute confirms).
- No separate OTLP export target is hardcoded; endpoint is read from instance config (APEX-26 surface).

---

### T10 — E2E probes (CI-gated)

Three automated probes that run in CI:

**Probe A — run JWT + permitted capability → tool succeeds + audit row:**
- Start a local cockpit server.
- Mint a `cockpit-mcp`-audience JWT with `granted_capabilities: ["board:read"]`.
- Call `listIssues` via MCP.
- Assert: HTTP 2xx, issues returned, one audit row with `outcome: "ok"` and matching `runId`.

**Probe B — run JWT + denied capability → 403 at API layer:**
- Same JWT but call `createComment` (requires `board:write`).
- Assert: HTTP 403 returned from the MCP server, no comment created in the DB, one audit row with `outcome: "denied"`. The 403 must originate from the enforcement in the service/API layer (not merely the MCP wrapper — verify by checking that the REST capability-check code path is hit, e.g. via a test spy or integration point label).

**Probe C — OAuth 2.1 simulated flow → `tools/list` succeeds:**
- Run a headless PKCE flow (test client generates verifier/challenge, calls authorize and token endpoints).
- Call `tools/list` with the resulting access token.
- Assert: HTTP 2xx, tool list returned, identity in audit row is user-scoped (userId set, runId null).

**Acceptance criteria:**
- All three probes pass in CI without manual intervention.
- Probes are added to the existing test suite (not a standalone script) and fail the CI check on regression.

---

## Out of scope for APEX-35

- Gateway OAuth/PKCE UI (consent page design is UX; basic redirect is sufficient for CI probes).
- APEX-26 OTLP endpoint provisioning (T9 reads from whatever APEX-26 delivers; it is a dependency, not in scope here).
- Capability schema versioning (capability strings are plain identifiers for now; versioning is follow-up).

---

## Dependencies

- APEX-26 — instance config surface (OTLP endpoint for T9; blocking for T9 only).
- APEX-20 — original typed-discovery failure mode this fixes.
- APEX-29 — design discussion this implements.
