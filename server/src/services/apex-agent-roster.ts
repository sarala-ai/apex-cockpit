/**
 * THE ROSTER — the four agents this product's own lifecycles commission, and
 * now the WHOLE built-in catalogue.
 *
 * Until this file existed, the only built-in agent definitions in the cockpit
 * were three inherited from the upstream fork (`briefs`, `learning`,
 * `reflection-coach`), whose instructions literally opened "You are Paperclip's
 * built-in…" and none of which did a job any seeded lifecycle asks for. So
 * every `agent` step in `server/src/apex/pipeline/lifecycles.ts` declared a
 * task with an acceptance contract and had nobody to commission: the executor
 * fell through to "the company's single assignable agent", which is a guess
 * dressed as a resolution.
 *
 * Those three have since been DELETED rather than left alongside the roster.
 * They were auto-provisioned into every company, so the fork's catalogue kept
 * seeding boards with agents no lifecycle would ever call — and a built-in
 * catalogue is a claim about what this product commissions. `DEFINITIONS` in
 * built-in-agents.ts is now exactly `APEX_AGENT_ROSTER`.
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
 *   Product Assistant `read-repos`       read-only tools + read-only git/gh;
 *                                        its ONLY write is a proposal
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
 * 2. **`read-only-broad` and `read-repos` are now enforced differently**, and
 *    the difference is `git`. `read-repos` adds Bash scoped per read-only VCS
 *    verb, because an agent that reconstructs what a product did cannot do it
 *    from files: commits, pull requests and releases are the evidence, and
 *    Glob/Grep/Read reach none of them.
 *
 *    This corrects a lie the roster shipped with. `read-repos` was originally
 *    ALIASED to `read-only-broad` on the stated ground that "--allowedTools
 *    gates by tool name" — an assumption inherited from an adapter comment and
 *    never tested. It is false: Claude Code honours `Bash(git log:*)` scoping,
 *    measured, with the evidence recorded in run-policy's module doc. The
 *    Product Assistant was therefore declared a repo reader while holding a
 *    grant that could not read a repository's history.
 *
 *    What is still NOT enforced, and is now said in the name's own comment
 *    rather than left to be inferred: reads are not path-scoped. `read-repos`
 *    bounds what a run can DO, not where it can look.
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
import {
  READ_REPOS_ALLOWED_TOOLS,
  nativeToolsForProfile,
  type PermissionProfile,
} from "../apex/steps/run-policy.js";
import type { BuiltInAgentDefinition } from "./built-in-agents.js";

const BUILT_INS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../built-ins/agents");

/**
 * Semver versions for each agent's charter file (the AGENTS.md that lands as
 * the system prompt via instructionsFilePath). Bump when the file's load-bearing
 * rules change — the version is stamped into heartbeat_runs.contextSnapshot
 * as part of the identity bundle so APEX-46 first-pass-yield is attributable
 * per bundle version (APEX-68 T1/T5).
 */
export const APEX_CHARTER_VERSIONS: Record<string, string> = {
  [/* implementer */ "implementer"]: "1.0",
  [/* specifier  */ "specifier"]: "1.0",
};

function instructions(key: string): string {
  return readFileSync(path.join(BUILT_INS_DIR, key, "AGENTS.md"), "utf8");
}

/** A routine's authored body, frontmatter included. The markdown is the routine DESCRIPTION the
 *  run reads; its frontmatter mirrors the definition below so the file reads as
 *  a whole routine to a person editing it. */
function routine(key: string, routineKey: string): string {
  return readFileSync(path.join(BUILT_INS_DIR, key, "routines", `${routineKey}.md`), "utf8");
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

const RAW_APEX_AGENT_ROSTER: BuiltInAgentDefinition[] = [
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
    // instructionsFilePath: charter mounts as the CLI system prompt (APEX-68 T1).
    // paperclipSkillSync: craft skills synced into every run workspace (APEX-68 T3).
    // Permission keys (dangerouslySkipPermissions, allowedTools) are injected by
    // withGovernedAdapterConfig so they stay in sync with the profile above.
    defaultAdapterConfig: {
      instructionsFilePath: path.join(BUILT_INS_DIR, "implementer", "AGENTS.md"),
      paperclipSkillSync: {
        desiredSkills: ["pr-delivery", "review-response"],
      },
    },
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
    // instructionsFilePath: charter mounts as the CLI system prompt (APEX-68 T1).
    // paperclipSkillSync: craft skills synced into every run workspace (APEX-68 T3).
    defaultAdapterConfig: {
      instructionsFilePath: path.join(BUILT_INS_DIR, "specifier", "AGENTS.md"),
      paperclipSkillSync: {
        desiredSkills: ["spec-writing", "review-response"],
      },
    },
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
      // Access token, not the account password: apex-core's Penpot provider
      // prefers `Authorization: Token <token>` and only falls back to
      // email+password when no token is present. A token is revocable on its
      // own and rotates without touching the account, so the password path is
      // deliberately left unbound here.
      PENPOT_ACCESS_TOKEN: userSecret("PENPOT_ACCESS_TOKEN"),
      // APEX_GATEWAY_TOKEN is deliberately NOT declared here. It is the
      // cockpit server's own credential for calling apex-gateway — its only
      // readers are gateway-client.ts, apex-setup-state.ts and
      // apex-gateway-observe.ts, all server-side. Nothing in apex/core (the
      // CLI this agent shells) reads it, so binding it would hand a
      // cockpit-scoped credential to an agent that has no call for it, and
      // an unbound declaration blocks dispatch outright.
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
    // `read-repos`: the read-only native tools PLUS Bash scoped to read-only
    // VCS verbs — `git log`, `git show`, `git diff`, `gh pr view`, and the
    // rest. Not decoration: reconstruction runs on commits, pull requests and
    // releases, and Glob/Grep/Read reach none of them. History is not a file,
    // so a "repo reader" without `git log` is a scanning agent that cannot
    // scan. The grant carries no write verb of any kind.
    //
    // What it does NOT enforce, said plainly rather than implied by the name:
    // reads are not path-scoped. The profile bounds what this agent can DO,
    // not where it can look, and a checkout's untracked .env is as readable as
    // its source. That is why "never quote a credential you encounter" is a
    // rule in its instructions rather than an assumption about its sandbox.
    defaultPermissionProfile: "read-repos",
    // The profile alone would be a claim, not a control: `run-policy` is read
    // at FLOW-commission time only, and this agent's headline job — the
    // reconstruction routine below — is dispatched by the routine scheduler,
    // which never passes through it and would otherwise inherit the adapter's
    // full bypass. Carrying the same grant on the agent's own adapterConfig is
    // what makes the boundary true on every run, from the same constant, so
    // the two cannot drift.
    defaultAdapterConfig: {
      dangerouslySkipPermissions: false,
      allowedTools: READ_REPOS_ALLOWED_TOOLS,
    },
    defaultPermissions: { canCreateAgents: false, canCreateSkills: false },
    // `gh` against a private repo needs a token. Declared as a NON-required
    // reference: it creates the slot an operator can fill, without blocking a
    // machine whose `gh` is already authenticated through its own keyring.
    // Never a value — see the module doc's credentials note.
    defaultAdapterEnv: {
      GH_TOKEN: { type: "user_secret_ref", key: "GH_TOKEN", required: false },
    },
    allowedAdapterTypes: ROSTER_ADAPTER_TYPES,
    defaultBudgetMonthlyCents: 0,
    autoProvision: true,
    /**
     * THE BROWNFIELD ROUTINE.
     *
     * A company arriving with years of shipped work and an empty board had no
     * bulk path onto it — only "Add Goal", one at a time, which is how a board
     * gets abandoned rather than corrected. This is that path, and its shape is
     * the doctrine: it reads the repositories, the specs and the board's own
     * history, and emits ONE proposal for a person to review.
     *
     * `status: "paused"` and the schedule trigger `enabled: false` together mean
     * it spends nothing until someone asks for it. Reconstruction is a
     * first-contact act, not a background job — running it monthly by default
     * would re-propose the same rows at a reviewer who already corrected them.
     * The cron expression exists so the operator has something to enable, not
     * because anything should be enabled.
     *
     * No skill in this bundle. A bundle CAN split an operating procedure
     * (skill) from a bounded run configuration (routine), and the fork's own
     * reflection-coach did, because the procedure was reused across targets;
     * here there is one procedure and one routine, and putting the doctrine in
     * two files would let them drift.
     */
    bundle: {
      stockVersion: "2026-08-03",
      instructions: {
        entryFile: "AGENTS.md",
        files: { "AGENTS.md": instructions("product-assistant") },
      },
      routine: {
        routineKey: "reconstruct-initiatives",
        title: "Reconstruct initiatives and projects from the repositories and the board",
        description: routine("product-assistant", "reconstruct-initiatives"),
        status: "paused",
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [
          {
            name: "repoPaths",
            label: "Repository paths (comma-separated; blank scans every registered repo)",
            type: "text",
            defaultValue: "",
            required: false,
            options: [],
          },
          // Wide by default and capped anyway: a brownfield product's history is
          // the point, and the record cap — not the window — is what bounds the
          // run's cost and the reviewer's reading.
          { name: "lookbackDays", label: "Lookback days", type: "number", defaultValue: 540, required: true, options: [] },
          // The reviewer's budget, not the agent's. Forty rows with provenance
          // is a long but finishable scan; two hundred is a spreadsheet nobody
          // reads, which is the failure this whole surface replaced.
          { name: "maxRecords", label: "Max records in the proposal", type: "number", defaultValue: 40, required: true, options: [] },
          {
            name: "recordKind",
            label: "What to reconstruct",
            type: "select",
            defaultValue: "initiatives",
            required: true,
            // One option because one proposal kind is registered. The variable
            // exists so adding a kind is a registration, not a rewrite.
            options: ["initiatives"],
          },
        ],
        triggers: [
          {
            kind: "schedule",
            label: "Reconstruction sweep",
            enabled: false,
            cronExpression: "0 9 1 * *",
            timezone: "UTC",
          },
        ],
      },
    },
  },
];

/*
 * Make every roster entry's profile true on EVERY run, not just flow-commissioned ones.
 *
 * `run-policy.derivePermissionPolicy` has two callers (flow commission and the
 * pipeline agent port). A routine-triggered run reaches neither, so it inherits
 * the claude-local adapter's `dangerouslySkipPermissions: true` default and the
 * declared profile governs nothing. That is not a corner case: the reconstruction
 * routine IS a routine run, and a Specifier that could write files on that path
 * would defeat the one separation the roster exists to enforce — an agent that
 * can edit the spec can make its own diff true.
 *
 * So the same grant is carried on each agent's own `adapterConfig`, which
 * `execute.ts` reads on every run. Derived here from `nativeToolsForProfile`
 * rather than written per entry, because a per-entry copy is a place to forget
 * one — which is exactly what happened when only Product Assistant got it.
 * An entry may still set `defaultAdapterConfig` explicitly; that wins.
 */
function withGovernedAdapterConfig(definition: BuiltInAgentDefinition): BuiltInAgentDefinition {
  const profile = definition.defaultPermissionProfile;
  if (!profile) return definition;
  // Always stamp the permission keys on top — they must match the profile and
  // must not be overrideable by hand-authored defaultAdapterConfig fields. Any
  // other keys (instructionsFilePath, paperclipSkillSync, …) in the definition's
  // defaultAdapterConfig are preserved; the two permission keys win last.
  return {
    ...definition,
    defaultAdapterConfig: {
      ...(definition.defaultAdapterConfig ?? {}),
      dangerouslySkipPermissions: false,
      allowedTools: nativeToolsForProfile(profile),
    },
  };
}

/** The roster as it is seeded — every entry's profile made true on every run. */
export const APEX_AGENT_ROSTER: BuiltInAgentDefinition[] =
  RAW_APEX_AGENT_ROSTER.map(withGovernedAdapterConfig);

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
