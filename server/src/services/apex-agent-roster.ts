/**
 * THE ROSTER — the four agents this product's own lifecycles commission.
 *
 * Until this file existed, the only built-in agent definitions in the cockpit
 * were the three inherited from the upstream fork (`briefs`, `learning`,
 * `reflection-coach`), whose instructions literally open "You are Paperclip's
 * built-in…" and none of which does a job any seeded lifecycle asks for. So
 * every `agent` step in `server/src/apex/pipeline/lifecycles.ts` declared a
 * task with an acceptance contract and had nobody to commission: the executor
 * fell through to "the company's single assignable agent", which is a guess
 * dressed as a resolution.
 *
 * ── THE AXIS: PERMISSION SURFACE, NOT JOB TITLE ──
 *
 * The task already lives on the step. A stage carries `promptTemplate` and an
 * `acceptance` contract the SERVER evaluates, so "what to do" and "what counts
 * as done" are both step-side and need no agent to hold them. What a step
 * cannot carry is **what its executor is allowed to touch** — that is a
 * property of the runtime the run is dispatched into, applied at commission
 * time by `server/src/apex/steps/run-policy.ts`.
 *
 * So the roster is cut by BLAST RADIUS, and it is deliberately short:
 *
 *   Implementer       `bounded`          repo write + test execution
 *   Specifier         `read-only-broad`  documents and board records; NO repo write
 *   Design Engineer   `bounded`          Penpot + the design repo, via the apex CLI
 *   Product Assistant `read-repos`       read everything; writes proposals only
 *
 * Two consequences worth stating out loud, because both were live options:
 *
 * 1. **One agent serves two lifecycles.** The Implementer is commissioned by
 *    the bug lifecycle's `repro_fix` step and by the feature lifecycle's
 *    `tasks` step. Those steps ask for different work, but they ask for it
 *    with the same hands — write the repo, run the tests. Splitting them into
 *    a "Bug Fixer" and a "Feature Developer" would be two records with one
 *    permission surface, i.e. a job title masquerading as governance. Agent
 *    reuse across lifecycles is the norm here, not the exception.
 *
 * 2. **`read-only-broad` vs `read-repos` is a real distinction to the author
 *    even though v1 ENFORCES them identically** (run-policy aliases the second
 *    to the first until an adapter can scope reads by path). It is recorded
 *    rather than collapsed because the day the adapter grows path scoping, the
 *    Product Assistant tightens for free and the Specifier does not have to be
 *    re-reasoned about.
 *
 * ── WHY THE SPECIFIER HAS NO REPO WRITE ──
 *
 * Not squeamishness — the gate. A feature spec is approved at the
 * load-bearing gate of the feature lifecycle, and approving it PRE-APPROVES
 * every task derived from it. An agent that could both author the spec and
 * change the code could make the diff true by editing the spec, and the gate
 * would then be approving a description of work already done. The separation
 * is what makes that gate mean anything. (It writes documents and board
 * records through the cockpit's own surfaces, which `run-policy` does not
 * narrow — the native-tool grant governs the filesystem, not the product API.)
 *
 * ── CREDENTIALS ──
 *
 * `defaultAdapterEnv` declares the environment a definition NEEDS as secret
 * REFERENCES, never values. A prior Design Engineer record on the live
 * instance carried a plaintext `PENPOT_PASSWORD` / `APEX_GATEWAY_TOKEN` in
 * `adapterConfig.env` — a real exposure, because an agent record is read back
 * by the API, mirrored into config revisions, and carried into portability
 * exports. A `user_secret_ref` binding is the opposite shape: it declares the
 * NEED (and `syncAgentAdapterEnvBindings` registers it as a declaration when
 * the agent is written), the operator supplies the value once into the secret
 * store, and the run resolves it at dispatch. A definition in git therefore
 * never has a value to leak.
 *
 * ── WHY A SEPARATE MODULE ──
 *
 * `built-in-agents.ts` is the MECHANISM (provisioning, approval, bundle
 * reconciliation) and pulls in half the service layer. The roster is DATA, and
 * `server/src/apex/pipeline/lifecycles.ts` has to read it to wire each agent
 * step to its agent. Importing the mechanism into the seeder to get at the data
 * would drag the service graph into pipeline seeding; this module imports only
 * types, so both sides can read it cheaply.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvBinding } from "@paperclipai/shared";
import type { PermissionProfile } from "../apex/steps/run-policy.js";
import type { BuiltInAgentDefinition } from "./built-in-agents.js";

const BUILT_INS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../built-ins/agents");

function instructions(key: string): string {
  return readFileSync(path.join(BUILT_INS_DIR, key, "AGENTS.md"), "utf8");
}

/** The adapters a roster agent may be provisioned onto — every local coding
 *  adapter the fork ships. `process` is deliberately absent: these agents are
 *  commissioned unattended under a permission profile the claude/codex-style
 *  adapters understand, and a bare process adapter has no `--allowedTools`
 *  grant to receive it. */
const ROSTER_ADAPTER_TYPES = ["claude_local", "codex_local", "gemini_local", "opencode_local"];

/**
 * A secret the operator supplies ONCE, referenced by key. `required: true`
 * means the heartbeat surfaces a named, actionable "this secret is missing"
 * rather than dispatching a run that will fail obscurely inside a tool.
 */
function userSecret(key: string): EnvBinding {
  return { type: "user_secret_ref", key, required: true };
}

/** The roster's keys, as literals, so a lifecycle step can name one and the
 *  compiler catches a typo instead of the runtime resolving to nobody. */
export const APEX_AGENT_KEYS = {
  implementer: "implementer",
  specifier: "specifier",
  designEngineer: "design-engineer",
  productAssistant: "product-assistant",
} as const;

export type ApexAgentKey = (typeof APEX_AGENT_KEYS)[keyof typeof APEX_AGENT_KEYS];

export const APEX_AGENT_ROSTER: BuiltInAgentDefinition[] = [
  {
    key: APEX_AGENT_KEYS.implementer,
    displayName: "Implementer",
    featureKeys: ["lifecycle-bug-fix", "lifecycle-feature-implement"],
    shortPurpose:
      "Reproduces and fixes bugs, and executes an approved spec's tasks, with repo write and test execution.",
    defaultInstructions: instructions("implementer"),
    defaultRole: "engineering",
    defaultTitle: "Implementer",
    defaultIcon: "wrench",
    // `bounded`: the workspace-scoped native tool grant — Read/Edit/Write/Bash
    // inside the run's own checkout. This is the largest surface on the roster
    // and the only one that can change source code.
    defaultPermissionProfile: "bounded",
    defaultPermissions: { canCreateAgents: false, canCreateSkills: false },
    allowedAdapterTypes: ROSTER_ADAPTER_TYPES,
    defaultBudgetMonthlyCents: 0,
    autoProvision: true,
  },
  {
    key: APEX_AGENT_KEYS.specifier,
    displayName: "Specifier",
    featureKeys: ["lifecycle-feature-spec"],
    shortPurpose:
      "Drafts the spec a feature gate approves — task breakdown with machine-checkable criteria per task. No repo write.",
    defaultInstructions: instructions("specifier"),
    defaultRole: "product",
    defaultTitle: "Specifier",
    defaultIcon: "file-text",
    // `read-only-broad`: broad native READ tools, zero write and zero network.
    // Documents and board records are written through the product's own
    // surfaces, which this grant does not govern — see the module doc.
    defaultPermissionProfile: "read-only-broad",
    defaultPermissions: { canCreateAgents: false, canCreateSkills: false },
    allowedAdapterTypes: ROSTER_ADAPTER_TYPES,
    defaultBudgetMonthlyCents: 0,
    autoProvision: true,
  },
  {
    key: APEX_AGENT_KEYS.designEngineer,
    displayName: "Design Engineer",
    featureKeys: ["lifecycle-design-change"],
    shortPurpose:
      "Authors design-board changes in Penpot and opens the .penpot pull request on the design repo, through the apex CLI.",
    defaultInstructions: instructions("design-engineer"),
    defaultRole: "design",
    defaultTitle: "Design Engineer",
    defaultIcon: "palette",
    // `bounded`: it shells the apex CLI and writes an exported .penpot into a
    // working directory. Its narrowing is which TOOLS it is told to use, not a
    // smaller native grant — v1 has no per-run MCP/CLI gate (run-policy's
    // "broad-read default" note), so the instruction file carries the
    // design-repo-only boundary explicitly.
    defaultPermissionProfile: "bounded",
    defaultPermissions: { canCreateAgents: false, canCreateSkills: false },
    // REFERENCES, never values. See the module doc's credentials section.
    defaultAdapterEnv: {
      PENPOT_PASSWORD: userSecret("PENPOT_PASSWORD"),
      APEX_GATEWAY_TOKEN: userSecret("APEX_GATEWAY_TOKEN"),
    },
    allowedAdapterTypes: ROSTER_ADAPTER_TYPES,
    defaultBudgetMonthlyCents: 0,
    autoProvision: true,
  },
  {
    key: APEX_AGENT_KEYS.productAssistant,
    displayName: "Product Assistant",
    featureKeys: ["product-assistant"],
    shortPurpose:
      "Answers questions about the product's history from the repos and the board, and writes proposals rather than changes.",
    defaultInstructions: instructions("product-assistant"),
    defaultRole: "product",
    defaultTitle: "Product Assistant",
    defaultIcon: "search",
    // `read-repos`: read-only, declared as repo-scoped. v1 enforces it exactly
    // as `read-only-broad` and run-policy says so in a note on every run; the
    // declaration is kept so it tightens for free once an adapter can scope
    // reads by path.
    defaultPermissionProfile: "read-repos",
    defaultPermissions: { canCreateAgents: false, canCreateSkills: false },
    allowedAdapterTypes: ROSTER_ADAPTER_TYPES,
    defaultBudgetMonthlyCents: 0,
    autoProvision: true,
  },
];

const ROSTER_BY_KEY = new Map(APEX_AGENT_ROSTER.map((definition) => [definition.key, definition]));

/**
 * The permission profile a step must declare when it commissions this agent.
 *
 * ONE source of truth, read by the lifecycle seeder so a stage's
 * `onEnter.permissions.profile` cannot drift from the roster entry it names.
 * Throws on an unknown key rather than defaulting: a step naming an agent that
 * does not exist is an authoring bug, and silently handing it the safest
 * profile would hide it until someone wondered why the run had no tools.
 */
export function apexAgentPermissionProfile(key: string): PermissionProfile {
  const definition = ROSTER_BY_KEY.get(key);
  if (!definition?.defaultPermissionProfile) {
    throw new Error(`Unknown APEX roster agent key: ${key}`);
  }
  return definition.defaultPermissionProfile;
}
