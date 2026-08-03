import { createHash } from "node:crypto";
import { readPaperclipSkillSyncPreference, writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, builtInManagedResources, companies, issueThreadInteractions, issues, routines, routineTriggers } from "@paperclipai/db";
import { syncRoutineVariablesWithTemplate } from "@paperclipai/shared";
import type { Agent, Approval, CompanySkill, EnvBinding, PermissionKey, Routine, RoutineTrigger, RoutineVariable } from "@paperclipai/shared";
import { PERMISSION_PROFILES, type PermissionProfile } from "../apex/steps/run-policy.js";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { agentService } from "./agents.js";
import { approvalService } from "./approvals.js";
import {
  readBuiltInAgentMarker,
  withBuiltInAgentMarker,
} from "./built-in-agent-metadata.js";
import { companySkillService } from "./company-skills.js";
import { routineService } from "./routines.js";
import { secretService } from "./secrets.js";
import { accessService } from "./access.js";
import { APEX_AGENT_ROSTER } from "./apex-agent-roster.js";

export type BuiltInAgentStatus = "not_provisioned" | "pending_approval" | "needs_setup" | "ready" | "paused";

export interface BuiltInAgentDefinition {
  key: string;
  displayName: string;
  featureKeys: string[];
  shortPurpose: string;
  defaultInstructions: string;
  defaultRole: string;
  defaultTitle?: string | null;
  defaultIcon?: string | null;
  defaultPermissions?: Record<string, unknown>;
  defaultStatus?: "idle" | "paused";
  defaultManager?: "single_root_agent" | null;
  allowedAdapterTypes?: string[];
  defaultBudgetMonthlyCents?: number;
  /**
   * The run-policy profile a step must declare when it commissions this agent
   * (`server/src/apex/steps/run-policy.ts`). Recorded on the agent record's
   * `permissions` so the blast radius is legible where the agent is, and read
   * by the lifecycle seeder so a step and its agent cannot disagree about it.
   *
   * Optional because the three inherited fork definitions predate the idea and
   * are never commissioned by a lifecycle step; every roster definition sets it.
   */
  defaultPermissionProfile?: PermissionProfile;
  /**
   * Environment this definition NEEDS, declared as secret REFERENCES.
   *
   * Never a value. `syncAgentAdapterEnvBindings` turns each entry into a
   * binding/declaration when the agent record is written, so the operator
   * supplies the secret once into the store and the run resolves it at
   * dispatch. A definition living in git therefore has nothing to leak.
   */
  defaultAdapterEnv?: Record<string, EnvBinding>;
  /**
   * Adapter config the definition needs on EVERY run, not only the ones a flow
   * commissions.
   *
   * The distinction is load-bearing. `defaultPermissionProfile` is read by
   * `run-policy` at flow-commission time and by nothing else — a
   * routine-triggered or ticket-assigned run of the same agent never passes
   * through it and gets the adapter's own default, which is full bypass. An
   * agent whose blast radius is part of what it IS (the Product Assistant
   * cannot be allowed to edit the history it reports on) has to carry the
   * grant on its own record, via the seam `execute.ts` already reads:
   * `dangerouslySkipPermissions: false` plus an explicit `allowedTools`.
   *
   * Operator input wins per key — someone who deliberately widens an agent
   * has done so on the record, which is auditable; silently re-narrowing them
   * at every reconcile would not be.
   *
   * Never a credential. Same rule as `defaultAdapterEnv`: this object is read
   * back by the API, mirrored into config revisions and carried into
   * portability exports.
   */
  defaultAdapterConfig?: Record<string, unknown>;
  /**
   * Provision this definition into every company at startup.
   *
   * Before the roster, the only auto-provisioned definitions were the ones
   * carrying a `bundle` (i.e. `reflection-coach`), which made "has a bundle"
   * accidentally mean "is part of the workforce". A lifecycle agent step needs
   * its agent to EXIST before the first ticket reaches it, and none of the
   * roster carries a bundle — so the intent is declared directly instead of
   * inferred from an unrelated field.
   */
  autoProvision?: boolean;
  bundle?: BuiltInAgentBundleDefinition;
}

export interface BuiltInAgentState {
  definition: BuiltInAgentDefinition;
  status: BuiltInAgentStatus;
  agentId: string | null;
  agent: Agent | null;
  pauseReason: string | null;
  resources: BuiltInManagedResourceState[];
  approval?: Approval | null;
}

export interface BuiltInAgentProvisionInput {
  adapterType?: string;
  adapterConfig?: Record<string, unknown>;
  budgetMonthlyCents?: number;
}

export interface BuiltInAgentProvisionActor {
  requestedByAgentId?: string | null;
  requestedByUserId?: string | null;
}

export interface BuiltInAgentProvisionResult {
  state: BuiltInAgentState;
  approval: Approval | null;
}

export type BuiltInManagedResourceKind = "instructions" | "skill" | "routine";
export type BuiltInManagedResourceStockStatus =
  | "missing"
  | "stock_current"
  | "stock_update_available"
  | "operator_modified";

export interface BuiltInManagedResourceState {
  resourceKind: BuiltInManagedResourceKind;
  resourceKey: string;
  resourceId: string | null;
  stockVersion: string;
  stockHash: string;
  currentHash: string | null;
  stockStatus: BuiltInManagedResourceStockStatus;
  updateAvailable: boolean;
  resetAvailable: boolean;
  changedFiles?: string[];
  scheduleEnabled?: boolean;
  pendingUpdateInteractionId?: string | null;
  pendingUpdateIssueId?: string | null;
  pendingUpdateIssueIdentifier?: string | null;
}

export interface BuiltInAgentBundleDefinition {
  stockVersion: string;
  instructions: {
    entryFile: string;
    files: Record<string, string>;
  };
  /**
   * OPTIONAL. A bundle exists to ship whatever managed resources an agent
   * needs; a skill is one of them, not a tax on the other two. The Product
   * Assistant ships instructions + a routine and no skill, because its
   * operating procedure IS the routine — inventing a SKILL.md to satisfy a
   * required field would put the same doctrine in two files that then drift.
   */
  skill?: {
    skillKey: string;
    displayName: string;
    slug: string;
    canonicalKey: string;
    files: Record<string, string>;
  };
  routine: {
    routineKey: string;
    title: string;
    description: string;
    status: "active" | "paused";
    priority: "critical" | "high" | "medium" | "low";
    concurrencyPolicy: "always_enqueue" | "coalesce_if_active" | "skip_if_active";
    catchUpPolicy: "enqueue_missed_with_cap" | "skip_missed";
    variables: RoutineVariable[];
    triggers: Array<{
      kind: "schedule";
      label: string | null;
      enabled: boolean;
      cronExpression: string;
      timezone: string;
    }>;
  };
}

export interface RequiredBuiltInAgentWarning {
  code: "built_in_agent_paused";
  key: string;
  agentId: string;
  message: string;
  pauseReason: string | null;
}

export interface RequiredBuiltInAgent {
  definition: BuiltInAgentDefinition;
  agent: Agent;
  warning: RequiredBuiltInAgentWarning | null;
}

const BUILT_IN_AGENT_KEY_PATTERN = /^[a-z][a-z0-9_-]*$/;

// Naming convention for built-in agent displayName (which becomes the
// created agent's `name` — see the `name: definition.displayName` call
// sites below): agent names surface on tickets, PRs, and GitHub audit
// comments read by humans who are not engineers, so they must read as a
// business role, not an internal engineering identifier. Concretely:
//   - Space-separated Title Case words (e.g. "Reflection Coach",
//     "Workflow Verification Agent"), never camelCase/glued-together
//     identifiers (e.g. "LoopValidator" — a real name this convention
//     exists to rule out; "Workflow Verification Agent" or "QA Agent" is
//     the readable equivalent for the same role).
//   - Prefer "<Function> Agent" (e.g. "Briefs Agent") unless the role/title
//     alone already reads naturally as a name (e.g. "Reflection Coach").
// Enforced mechanically below (shape only — the "does this read as a
// business role" judgment call still lives with whoever adds the
// definition); this does NOT touch existing rows in any live database — see
// the "renaming existing agents" note in the founder's identity-fix request.
const BUILT_IN_AGENT_DISPLAY_NAME_PATTERN = /^[A-Z][a-zA-Z0-9']*(\s[A-Z][a-zA-Z0-9']*)*$/;

// THE ROSTER IS THE WHOLE CATALOGUE.
//
// This list used to be the roster PLUS three definitions inherited from the
// upstream fork — `briefs`, `learning` and `reflection-coach`, whose
// instructions opened "You are Paperclip's built-in…" and none of which any
// seeded lifecycle commissioned. They were auto-provisioned into every company
// regardless, so a fresh board arrived carrying three agents that did no
// declared job and one paused routine nobody had asked for. Removed: a built-in
// catalogue is a claim about what this product commissions, and inheriting
// someone else's claim makes it a lie.
//
// The four agents below are cut by permission surface rather than job title.
// See ./apex-agent-roster.ts — the reasoning lives beside the definitions, not
// here.
const DEFINITIONS = validateBuiltInAgentDefinitions([
  ...APEX_AGENT_ROSTER,
]);

const DEFINITIONS_BY_KEY = new Map(DEFINITIONS.map((definition) => [definition.key, definition]));

const ROOT_AGENT_DEFAULT_CHANGE_GRANTS: PermissionKey[] = ["agents:configure", "skills:create"];
/**
 * Change-grants a built-in agent receives at provision time, keyed by
 * definition.
 *
 * Empty on purpose. The only entry was `reflection-coach`, whose whole job was
 * proposing edits to other agents' instructions and to company skills; no
 * roster agent proposes changes to the company's own configuration, so no
 * roster agent is granted `agents:suggest-changes` or `skills:suggest-changes`.
 * Kept as the seam rather than deleted: `ensureBuiltInAgentDefaultGrants` reads
 * it per definition, and a roster agent that ever needs a standing grant should
 * declare it here — in git, next to the definitions — rather than have it
 * conferred by a migration on a live board.
 */
const BUILT_IN_AGENT_DEFAULT_GRANTS: Record<string, PermissionKey[]> = {};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueNonEmptyStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function stockHash(value: unknown) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function changedFileList(currentFiles: Record<string, string | null>, stockFiles: Record<string, string>) {
  const paths = new Set([...Object.keys(currentFiles), ...Object.keys(stockFiles)]);
  return [...paths]
    .filter((filePath) => (currentFiles[filePath] ?? null) !== (stockFiles[filePath] ?? null))
    .sort((left, right) => left.localeCompare(right));
}

function resourceStatus(input: {
  resourceId: string | null;
  currentHash: string | null;
  bindingStockHash: string | null;
  latestStockHash: string;
}): BuiltInManagedResourceStockStatus {
  if (!input.resourceId || !input.currentHash) return "missing";
  if (input.currentHash === input.latestStockHash) return "stock_current";
  if (input.bindingStockHash && input.currentHash === input.bindingStockHash) {
    return "stock_update_available";
  }
  return "operator_modified";
}

function stockState(input: {
  resourceKind: BuiltInManagedResourceKind;
  resourceKey: string;
  resourceId: string | null;
  stockVersion: string;
  latestStockHash: string;
  currentHash: string | null;
  bindingStockHash: string | null;
  changedFiles?: string[];
  scheduleEnabled?: boolean;
  pendingUpdateInteractionId?: string | null;
  pendingUpdateIssueId?: string | null;
  pendingUpdateIssueIdentifier?: string | null;
}): BuiltInManagedResourceState {
  const status = resourceStatus({
    resourceId: input.resourceId,
    currentHash: input.currentHash,
    bindingStockHash: input.bindingStockHash,
    latestStockHash: input.latestStockHash,
  });
  return {
    resourceKind: input.resourceKind,
    resourceKey: input.resourceKey,
    resourceId: input.resourceId,
    stockVersion: input.stockVersion,
    stockHash: input.latestStockHash,
    currentHash: input.currentHash,
    stockStatus: status,
    updateAvailable: status === "stock_update_available" || status === "operator_modified",
    resetAvailable: status !== "stock_current",
    ...(input.changedFiles && input.changedFiles.length > 0 ? { changedFiles: input.changedFiles } : {}),
    ...(input.scheduleEnabled !== undefined ? { scheduleEnabled: input.scheduleEnabled } : {}),
    ...(input.pendingUpdateInteractionId !== undefined
      ? { pendingUpdateInteractionId: input.pendingUpdateInteractionId }
      : {}),
    ...(input.pendingUpdateIssueId !== undefined ? { pendingUpdateIssueId: input.pendingUpdateIssueId } : {}),
    ...(input.pendingUpdateIssueIdentifier !== undefined
      ? { pendingUpdateIssueIdentifier: input.pendingUpdateIssueIdentifier }
      : {}),
  };
}

export function validateBuiltInAgentDefinitions(definitions: BuiltInAgentDefinition[]) {
  const seenKeys = new Set<string>();
  for (const definition of definitions) {
    if (!BUILT_IN_AGENT_KEY_PATTERN.test(definition.key)) {
      throw new Error(`Invalid built-in agent key: ${definition.key}`);
    }
    if (seenKeys.has(definition.key)) {
      throw new Error(`Duplicate built-in agent key: ${definition.key}`);
    }
    seenKeys.add(definition.key);
    if (!definition.displayName.trim()) {
      throw new Error(`Built-in agent ${definition.key} requires a displayName`);
    }
    if (!BUILT_IN_AGENT_DISPLAY_NAME_PATTERN.test(definition.displayName)) {
      throw new Error(
        `Built-in agent ${definition.key} displayName "${definition.displayName}" must read as a business role ` +
          `— space-separated Title Case words (e.g. "Workflow Verification Agent"), not a glued-together ` +
          `identifier like "LoopValidator".`,
      );
    }
    if (!definition.shortPurpose.trim()) {
      throw new Error(`Built-in agent ${definition.key} requires a shortPurpose`);
    }
    if (!definition.defaultInstructions.trim()) {
      throw new Error(`Built-in agent ${definition.key} requires defaultInstructions`);
    }
    if (!definition.defaultRole.trim()) {
      throw new Error(`Built-in agent ${definition.key} requires a defaultRole`);
    }
    if (uniqueNonEmptyStrings(definition.featureKeys).length !== definition.featureKeys.length) {
      throw new Error(`Built-in agent ${definition.key} featureKeys must be unique non-empty strings`);
    }
    if (definition.featureKeys.length === 0) {
      throw new Error(`Built-in agent ${definition.key} requires at least one featureKey`);
    }
    if (
      definition.allowedAdapterTypes
      && uniqueNonEmptyStrings(definition.allowedAdapterTypes).length !== definition.allowedAdapterTypes.length
    ) {
      throw new Error(`Built-in agent ${definition.key} allowedAdapterTypes must be unique non-empty strings`);
    }
    if (
      definition.defaultBudgetMonthlyCents !== undefined
      && (!Number.isInteger(definition.defaultBudgetMonthlyCents) || definition.defaultBudgetMonthlyCents < 0)
    ) {
      throw new Error(`Built-in agent ${definition.key} defaultBudgetMonthlyCents must be a non-negative integer`);
    }
    if (
      definition.defaultPermissionProfile !== undefined
      && !(PERMISSION_PROFILES as readonly string[]).includes(definition.defaultPermissionProfile)
    ) {
      throw new Error(
        `Built-in agent ${definition.key} defaultPermissionProfile must be one of ` +
          `${PERMISSION_PROFILES.join(", ")} — run-policy degrades an unrecognized profile to the safest ` +
          `default silently, so a typo here would quietly change an agent's blast radius.`,
      );
    }
    // A definition in git must never carry a credential VALUE. `envBindingSchema`
    // still accepts a bare string for backward compatibility with rows humans
    // authored; a DEFINITION has no such history, so the loose form is refused
    // here rather than relied on never being used.
    for (const [envKey, binding] of Object.entries(definition.defaultAdapterEnv ?? {})) {
      if (typeof binding === "string" || !isPlainRecord(binding) || binding.type === "plain") {
        throw new Error(
          `Built-in agent ${definition.key} defaultAdapterEnv.${envKey} must be a secret REFERENCE ` +
            `({type:"secret_ref"} or {type:"user_secret_ref"}), never a literal value — an agent record is ` +
            `read back by the API, mirrored into config revisions, and carried into portability exports.`,
        );
      }
    }
    // Environment belongs in `defaultAdapterEnv`, where every entry is forced
    // to be a secret REFERENCE. Allowing it through here would reopen exactly
    // the hole that check exists to close, one indirection further out.
    if (definition.defaultAdapterConfig && "env" in definition.defaultAdapterConfig) {
      throw new Error(
        `Built-in agent ${definition.key} defaultAdapterConfig must not carry 'env' — ` +
          `declare environment as secret references in defaultAdapterEnv instead.`,
      );
    }
    if (definition.bundle) {
      if (!definition.bundle.stockVersion.trim()) {
        throw new Error(`Built-in agent ${definition.key} bundle requires a stockVersion`);
      }
      if (!definition.bundle.instructions.files[definition.bundle.instructions.entryFile]) {
        throw new Error(`Built-in agent ${definition.key} bundle instructions require the entry file`);
      }
      if (definition.bundle.skill && !definition.bundle.skill.files[`${definition.bundle.skill.slug}/SKILL.md`]) {
        throw new Error(`Built-in agent ${definition.key} bundle skill requires SKILL.md`);
      }
      if (!definition.bundle.routine.description.trim()) {
        throw new Error(`Built-in agent ${definition.key} bundle routine requires a description`);
      }
    }
  }
  return definitions.map((definition) => ({
    ...definition,
    featureKeys: [...definition.featureKeys],
    allowedAdapterTypes: definition.allowedAdapterTypes ? [...definition.allowedAdapterTypes] : undefined,
    bundle: definition.bundle ? {
      ...definition.bundle,
      instructions: {
        ...definition.bundle.instructions,
        files: { ...definition.bundle.instructions.files },
      },
      skill: definition.bundle.skill
        ? {
          ...definition.bundle.skill,
          files: { ...definition.bundle.skill.files },
        }
        : undefined,
      routine: {
        ...definition.bundle.routine,
        variables: definition.bundle.routine.variables.map((variable) => ({ ...variable, options: [...variable.options] })),
        triggers: definition.bundle.routine.triggers.map((trigger) => ({ ...trigger })),
      },
    } : undefined,
  }));
}

export function listBuiltInAgentDefinitions() {
  return DEFINITIONS.map((definition) => ({ ...definition, featureKeys: [...definition.featureKeys] }));
}

export function getBuiltInAgentDefinition(key: string) {
  return DEFINITIONS_BY_KEY.get(key) ?? null;
}

export function requireBuiltInAgentDefinition(key: string) {
  const definition = getBuiltInAgentDefinition(key);
  if (!definition) throw notFound(`Built-in agent definition not found: ${key}`);
  return definition;
}

function defaultAdapterType(definition: BuiltInAgentDefinition) {
  return definition.allowedAdapterTypes?.[0] ?? "process";
}

function normalizeAdapterType(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function selectPreferredAdapterType(
  definition: BuiltInAgentDefinition,
  usage: Array<{ adapterType: string; count: number }>,
) {
  const fallback = defaultAdapterType(definition);
  const preference = definition.allowedAdapterTypes ?? [];
  if (preference.length === 0) return fallback;

  const rank = new Map(preference.map((adapterType, index) => [adapterType, index]));
  let selected: { adapterType: string; count: number; rank: number } | null = null;
  for (const entry of usage) {
    const adapterRank = rank.get(entry.adapterType);
    if (adapterRank === undefined) continue;
    if (!selected || entry.count > selected.count || (entry.count === selected.count && adapterRank < selected.rank)) {
      selected = { ...entry, rank: adapterRank };
    }
  }
  return selected?.adapterType ?? fallback;
}

function assertAdapterAllowed(definition: BuiltInAgentDefinition, adapterType: string) {
  if (definition.allowedAdapterTypes && !definition.allowedAdapterTypes.includes(adapterType)) {
    throw unprocessable(`Adapter type ${adapterType} is not allowed for built-in agent ${definition.key}`, {
      code: "built_in_agent_adapter_not_allowed",
      key: definition.key,
      allowedAdapterTypes: definition.allowedAdapterTypes,
    });
  }
}

function hasCompleteAdapterConfig(adapterType: string, adapterConfig: unknown) {
  if (!isPlainRecord(adapterConfig)) return false;
  if (["process", "command"].includes(adapterType)) {
    return nonEmptyString(adapterConfig.command) || nonEmptyString(adapterConfig.script);
  }
  if (adapterType === "http") {
    return nonEmptyString(adapterConfig.url) || nonEmptyString(adapterConfig.endpoint) || nonEmptyString(adapterConfig.webhookUrl);
  }
  if (adapterType === "openclaw_gateway" || adapterType === "hermes_gateway") {
    return nonEmptyString(adapterConfig.baseUrl) || nonEmptyString(adapterConfig.url);
  }
  return nonEmptyString(adapterConfig.model);
}

export function deriveBuiltInAgentStatus(agent: Pick<Agent, "adapterType" | "adapterConfig" | "status" | "pausedAt"> | null): BuiltInAgentStatus {
  if (!agent) return "not_provisioned";
  if (agent.status === "pending_approval") return "pending_approval";
  if (agent.status === "paused" || agent.pausedAt) return "paused";
  return hasCompleteAdapterConfig(agent.adapterType, agent.adapterConfig) ? "ready" : "needs_setup";
}

function builtInMetadata(definition: BuiltInAgentDefinition, existing?: Record<string, unknown> | null) {
  return withBuiltInAgentMarker(existing, {
    key: definition.key,
    featureKeys: definition.featureKeys,
  });
}

/**
 * The definition's declared secret REFERENCES, merged under `adapterConfig.env`
 * without disturbing anything an operator already put there.
 *
 * Operator-set keys win: a company that binds `PENPOT_PASSWORD` to its own
 * company secret must not have that rewritten to the stock user-secret
 * reference on every startup reconcile. The definition only fills in what is
 * absent, which is what "default" means everywhere else in this file.
 */
function withDefaultAdapterEnv(
  definition: BuiltInAgentDefinition,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  // Definition-level config first, operator input on top: an operator who
  // deliberately widens an agent has done so on the record.
  const merged = { ...(definition.defaultAdapterConfig ?? {}), ...adapterConfig };
  const defaults = definition.defaultAdapterEnv;
  if (!defaults || Object.keys(defaults).length === 0) return merged;
  const existingEnv = isPlainRecord(merged.env) ? merged.env : {};
  return { ...merged, env: { ...defaults, ...existingEnv } };
}

/** The agent record's `permissions`, carrying the definition's declared run
 *  profile so an agent's blast radius is legible where the agent is — not only
 *  on the steps that happen to commission it. */
function definitionPermissions(definition: BuiltInAgentDefinition): Record<string, unknown> {
  return {
    ...(definition.defaultPermissions ?? {}),
    ...(definition.defaultPermissionProfile ? { profile: definition.defaultPermissionProfile } : {}),
  };
}

function definitionPatch(definition: BuiltInAgentDefinition, input: BuiltInAgentProvisionInput = {}) {
  const adapterType = input.adapterType ?? defaultAdapterType(definition);
  assertAdapterAllowed(definition, adapterType);
  return {
    name: definition.displayName,
    role: definition.defaultRole,
    title: definition.defaultTitle ?? null,
    icon: definition.defaultIcon ?? null,
    capabilities: definition.shortPurpose,
    adapterType,
    adapterConfig: withDefaultAdapterEnv(definition, input.adapterConfig ?? {}),
    permissions: definitionPermissions(definition),
    budgetMonthlyCents: input.budgetMonthlyCents ?? definition.defaultBudgetMonthlyCents ?? 0,
  };
}

function builtInAgentNotConfiguredError(state: BuiltInAgentState) {
  return new HttpError(412, `Built-in agent is not configured: ${state.definition.key}`, {
    code: "built_in_agent_not_configured",
    key: state.definition.key,
    status: state.status,
    agentId: state.agentId,
    featureKeys: state.definition.featureKeys,
  });
}

function hasProvisionSetupInput(input: BuiltInAgentProvisionInput) {
  return input.adapterType !== undefined || input.adapterConfig !== undefined || input.budgetMonthlyCents !== undefined;
}

function rowIsBuiltInAgent(row: typeof agents.$inferSelect, key: string) {
  const marker = readBuiltInAgentMarker(row.metadata);
  return marker?.key === key;
}

export function builtInAgentService(db: Db) {
  const agentSvc = agentService(db);
  const accessSvc = accessService(db);
  const approvalSvc = approvalService(db);
  const instructionsSvc = agentInstructionsService();
  const skillSvc = companySkillService(db);
  const routineSvc = routineService(db);
  const secretsSvc = secretService(db);

  /**
   * Declare the SLOTS a definition's `user_secret_ref` bindings point at.
   *
   * `syncUserSecretDeclarationsForTarget` resolves each reference against a
   * user secret DEFINITION and 404s when there is none — so writing an agent
   * with a reference to a slot nobody has created fails the whole provision.
   * Creating the definition IS the declaration: an empty, valueless slot that
   * says "this company needs a PENPOT_PASSWORD, and here is who needs it",
   * which is exactly what an operator has to see in order to fill it in.
   *
   * No value is written, and none can be: `createUserSecretDefinition` takes a
   * key, a name and guidance. The secret itself is supplied once, by a person,
   * through the secrets UI. Idempotent by key — a definition an operator has
   * already created (possibly pointing at their own vault) is left untouched.
   */
  async function ensureDeclaredUserSecrets(companyId: string, definition: BuiltInAgentDefinition) {
    for (const [envKey, binding] of Object.entries(definition.defaultAdapterEnv ?? {})) {
      if (!isPlainRecord(binding) || binding.type !== "user_secret_ref") continue;
      const key = typeof binding.key === "string" ? binding.key.trim() : "";
      if (!key) continue;
      const existing = await secretsSvc.listUserSecretDefinitions(companyId);
      if (existing.some((row) => row.key === key)) continue;
      try {
        await secretsSvc.createUserSecretDefinition(companyId, {
          key,
          name: envKey,
          description: `Required by the built-in ${definition.displayName}.`,
          // `local_encrypted` with no provider config is the no-external-vault
          // path — it creates the slot without asserting a vault the company
          // may not have. An operator can repoint it at a real provider later.
          provider: "local_encrypted",
          usageGuidance:
            `Delivered to ${definition.displayName} as the ${envKey} environment variable at dispatch. ` +
            `The agent never sees or stores the value.`,
        });
      } catch (err) {
        // A concurrent reconcile created it first. Anything else is real.
        if (!(err instanceof HttpError) || err.status !== 409) throw err;
      }
    }
  }

  async function findSingleRootManager(companyId: string) {
    const roots = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    const nonBuiltInRoots = roots.filter((agent) => !readBuiltInAgentMarker(agent.metadata) && !agent.reportsTo);
    return nonBuiltInRoots.length === 1 ? nonBuiltInRoots[0]!.id : null;
  }

  async function ensureAgentDefaultGrants(companyId: string, agentId: string, grantKeys: PermissionKey[]) {
    if (grantKeys.length === 0) return 0;
    await accessSvc.ensureMembership(companyId, "agent", agentId, "member", "active");
    let ensured = 0;
    for (const permissionKey of grantKeys) {
      await accessSvc.setPrincipalPermission(companyId, "agent", agentId, permissionKey, true, null);
      ensured += 1;
    }
    return ensured;
  }

  async function ensureBuiltInAgentDefaultGrants(agent: Agent, definition: BuiltInAgentDefinition) {
    if (agent.status === "pending_approval" || agent.status === "terminated") return 0;
    return ensureAgentDefaultGrants(
      agent.companyId,
      agent.id,
      BUILT_IN_AGENT_DEFAULT_GRANTS[definition.key] ?? [],
    );
  }

  async function ensureRootAgentDefaultChangeGrants(companyId: string) {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    const rootCeoRows = rows.filter((agent) =>
      !readBuiltInAgentMarker(agent.metadata) &&
      !agent.reportsTo &&
      agent.role.trim().toLowerCase() === "ceo" &&
      agent.status !== "pending_approval"
    );
    if (rootCeoRows.length !== 1) return 0;
    return ensureAgentDefaultGrants(companyId, rootCeoRows[0]!.id, ROOT_AGENT_DEFAULT_CHANGE_GRANTS);
  }

  async function ensureCompanyDefaultAgentGrants(companyId: string) {
    let ensured = await ensureRootAgentDefaultChangeGrants(companyId);
    for (const definition of DEFINITIONS) {
      const agent = await findSingleAgent(companyId, definition);
      if (!agent) continue;
      ensured += await ensureBuiltInAgentDefaultGrants(agent as Agent, definition);
    }
    return ensured;
  }

  async function defaultProvisionInput(companyId: string, definition: BuiltInAgentDefinition, input: BuiltInAgentProvisionInput) {
    if (input.adapterType || input.adapterConfig) return input;
    // Deliberately still `bundle || autoProvision`, unlike the provisioning
    // filter in `autoProvisionBundledAgents`. Same shape, different question:
    // that one asks whether to CREATE the agent at all (consent), this one asks
    // whether to borrow a working adapter config from a sibling agent when a
    // caller provisions without naming one (convenience). A bundled definition
    // provisioned by hand still materializes instructions/skill/routine and
    // still needs a runnable adapter, so shipping content is a fair signal here
    // even though it is not consent there.
    if (!definition.bundle && !definition.autoProvision) return input;
    const rows = await db
      .select({
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    const candidate = rows.find((row) =>
      definition.allowedAdapterTypes?.includes(row.adapterType)
      && hasCompleteAdapterConfig(row.adapterType, row.adapterConfig)
    );
    if (!candidate) return input;
    return {
      ...input,
      adapterType: candidate.adapterType,
      adapterConfig: {},
    };
  }

  async function getManagedResourceBinding(
    companyId: string,
    bundleKey: string,
    resourceKind: BuiltInManagedResourceKind,
    resourceKey: string,
  ) {
    return db
      .select()
      .from(builtInManagedResources)
      .where(and(
        eq(builtInManagedResources.companyId, companyId),
        eq(builtInManagedResources.bundleKey, bundleKey),
        eq(builtInManagedResources.resourceKind, resourceKind),
        eq(builtInManagedResources.resourceKey, resourceKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function upsertManagedResourceBinding(input: {
    companyId: string;
    bundleKey: string;
    resourceKind: BuiltInManagedResourceKind;
    resourceKey: string;
    resourceId: string;
    stockVersion: string;
    stockHash: string;
    defaultsJson: Record<string, unknown>;
  }) {
    const now = new Date();
    return db
      .insert(builtInManagedResources)
      .values(input)
      .onConflictDoUpdate({
        target: [
          builtInManagedResources.companyId,
          builtInManagedResources.bundleKey,
          builtInManagedResources.resourceKind,
          builtInManagedResources.resourceKey,
        ],
        set: {
          resourceId: input.resourceId,
          stockVersion: input.stockVersion,
          stockHash: input.stockHash,
          defaultsJson: input.defaultsJson,
          updatedAt: now,
        },
      })
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function currentInstructionFiles(agent: Agent, bundle: BuiltInAgentBundleDefinition) {
    const currentFiles: Record<string, string | null> = {};
    for (const filePath of Object.keys(bundle.instructions.files)) {
      try {
        currentFiles[filePath] = (await instructionsSvc.readFile(agent, filePath)).content;
      } catch {
        currentFiles[filePath] = null;
      }
    }
    return currentFiles;
  }

  async function materializeInstructions(agent: Agent, definition: BuiltInAgentDefinition, mode: "reconcile" | "reset") {
    const bundle = definition.bundle!;
    const stock = stockHash(bundle.instructions.files);
    const binding = await getManagedResourceBinding(agent.companyId, definition.key, "instructions", "AGENTS.md");
    const currentFiles = await currentInstructionFiles(agent, bundle);
    const currentHash = Object.values(currentFiles).some((value) => value === null) ? null : stockHash(currentFiles);
    const currentState = stockState({
      resourceKind: "instructions",
      resourceKey: "AGENTS.md",
      resourceId: agent.id,
      stockVersion: bundle.stockVersion,
      latestStockHash: stock,
      currentHash,
      bindingStockHash: binding?.stockHash ?? null,
      changedFiles: changedFileList(currentFiles, bundle.instructions.files),
    });

    const shouldWrite =
      mode === "reset"
      || currentState.stockStatus === "missing"
      || currentState.stockStatus === "stock_update_available";
    if (!shouldWrite) {
      if (!binding && currentHash === stock) {
        await upsertManagedResourceBinding({
          companyId: agent.companyId,
          bundleKey: definition.key,
          resourceKind: "instructions",
          resourceKey: "AGENTS.md",
          resourceId: agent.id,
          stockVersion: bundle.stockVersion,
          stockHash: stock,
          defaultsJson: {
            entryFile: bundle.instructions.entryFile,
            files: Object.keys(bundle.instructions.files),
          },
        });
      }
      return currentState;
    }

    const materialized = await instructionsSvc.materializeManagedBundle(agent, bundle.instructions.files, {
      entryFile: bundle.instructions.entryFile,
      replaceExisting: true,
      clearLegacyPromptTemplate: true,
    });
    const updated = await agentSvc.update(agent.id, {
      adapterConfig: materialized.adapterConfig,
    }, {
      allowBuiltInAgentMetadata: true,
      recordRevision: { source: `built-in-bundle:${mode}:instructions` },
    });
    if (!updated) throw notFound("Built-in agent not found");
    await upsertManagedResourceBinding({
      companyId: agent.companyId,
      bundleKey: definition.key,
      resourceKind: "instructions",
      resourceKey: "AGENTS.md",
      resourceId: agent.id,
      stockVersion: bundle.stockVersion,
      stockHash: stock,
      defaultsJson: {
        entryFile: bundle.instructions.entryFile,
        files: Object.keys(bundle.instructions.files),
      },
    });
    return stockState({
      resourceKind: "instructions",
      resourceKey: "AGENTS.md",
      resourceId: agent.id,
      stockVersion: bundle.stockVersion,
      latestStockHash: stock,
      currentHash: stock,
      bindingStockHash: stock,
    });
  }

  async function getCurrentSkillFiles(companyId: string, skill: CompanySkill | null, bundle: BuiltInAgentBundleDefinition) {
    const currentFiles: Record<string, string | null> = {};
    const stockFiles = bundle.skill?.files ?? {};
    for (const packagePath of Object.keys(stockFiles)) {
      const relativePath = packagePath.split("/").slice(1).join("/") || "SKILL.md";
      if (!skill) {
        currentFiles[packagePath] = null;
        continue;
      }
      if (relativePath === "SKILL.md") {
        currentFiles[packagePath] = skill.markdown;
        continue;
      }
      try {
        currentFiles[packagePath] = (await skillSvc.readFile(companyId, skill.id, relativePath))?.content ?? null;
      } catch {
        currentFiles[packagePath] = null;
      }
    }
    return currentFiles;
  }

  async function importBundledSkill(companyId: string, definition: BuiltInAgentDefinition) {
    const bundleSkill = definition.bundle!.skill!;
    const results = await skillSvc.importPackageFiles(companyId, bundleSkill.files, { onConflict: "replace" });
    const imported = results.find((result) => result.skill.key === bundleSkill.canonicalKey)?.skill
      ?? results[0]?.skill
      ?? await skillSvc.getByKey(companyId, bundleSkill.canonicalKey);
    if (!imported) throw notFound("Built-in bundled skill was not imported");
    return imported;
  }

  async function syncBundledSkillToAgent(agent: Agent, skill: CompanySkill) {
    const desired = readPaperclipSkillSyncPreference(agent.adapterConfig as Record<string, unknown>).desiredSkillEntries;
    const nextDesired = [
      ...desired.filter((entry) => entry.key !== skill.key),
      { key: skill.key, versionId: skill.currentVersionId ?? null },
    ];
    const adapterConfig = writePaperclipSkillSyncPreference(agent.adapterConfig as Record<string, unknown>, nextDesired);
    const updated = await agentSvc.update(agent.id, { adapterConfig }, {
      allowBuiltInAgentMetadata: true,
      recordRevision: { source: "built-in-bundle:skill-sync" },
    });
    if (!updated) throw notFound("Built-in agent not found");
    return updated as Agent;
  }

  async function materializeSkill(agent: Agent, definition: BuiltInAgentDefinition, mode: "reconcile" | "reset") {
    const bundle = definition.bundle!;
    const bundleSkill = bundle.skill!;
    const stock = stockHash(bundleSkill.files);
    const binding = await getManagedResourceBinding(agent.companyId, definition.key, "skill", bundleSkill.skillKey);
    const boundSkill = binding ? await skillSvc.getById(agent.companyId, binding.resourceId) : null;
    const existingByKey = await skillSvc.getByKey(agent.companyId, bundleSkill.canonicalKey);
    const skill = boundSkill ?? existingByKey;
    const currentFiles = await getCurrentSkillFiles(agent.companyId, skill, bundle);
    const currentHash = skill && Object.values(currentFiles).every((value) => value !== null)
      ? stockHash(currentFiles)
      : null;
    const currentState = stockState({
      resourceKind: "skill",
      resourceKey: bundleSkill.skillKey,
      resourceId: skill?.id ?? null,
      stockVersion: bundle.stockVersion,
      latestStockHash: stock,
      currentHash,
      bindingStockHash: binding?.stockHash ?? null,
      changedFiles: changedFileList(currentFiles, bundleSkill.files),
    });

    const shouldWrite =
      mode === "reset"
      || currentState.stockStatus === "missing"
      || currentState.stockStatus === "stock_update_available";
    const nextSkill = shouldWrite ? await importBundledSkill(agent.companyId, definition) : skill!;
    await upsertManagedResourceBinding({
      companyId: agent.companyId,
      bundleKey: definition.key,
      resourceKind: "skill",
      resourceKey: bundleSkill.skillKey,
      resourceId: nextSkill.id,
      stockVersion: bundle.stockVersion,
      stockHash: shouldWrite ? stock : binding?.stockHash ?? stock,
      defaultsJson: {
        canonicalKey: bundleSkill.canonicalKey,
        slug: bundleSkill.slug,
        files: Object.keys(bundleSkill.files),
      },
    });
    await syncBundledSkillToAgent(agent, nextSkill);
    return stockState({
      resourceKind: "skill",
      resourceKey: bundleSkill.skillKey,
      resourceId: nextSkill.id,
      stockVersion: bundle.stockVersion,
      latestStockHash: stock,
      currentHash: shouldWrite ? stock : currentHash,
      bindingStockHash: shouldWrite ? stock : binding?.stockHash ?? stock,
      changedFiles: shouldWrite ? [] : changedFileList(currentFiles, bundleSkill.files),
    });
  }

  function normalizeRoutineVariablesForHash(input: {
    title: string;
    description?: string | null;
    variables?: RoutineVariable[] | null;
  }) {
    return syncRoutineVariablesWithTemplate(
      [input.title, input.description ?? ""],
      input.variables ?? [],
    ).map((variable) => ({
      name: variable.name,
      label: variable.label ?? null,
      type: variable.type ?? "text",
      defaultValue: variable.defaultValue ?? null,
      required: variable.required ?? true,
      options: variable.options ?? [],
    }));
  }

  function normalizeRoutineTriggersForHash(
    triggers: Array<{
      kind: string;
      label?: string | null;
      cronExpression?: string | null;
      timezone?: string | null;
    }>,
  ) {
    return triggers
      .filter((trigger) => trigger.kind === "schedule")
      .map((trigger) => ({
        kind: "schedule",
        label: trigger.label ?? null,
        cronExpression: trigger.cronExpression ?? "",
        timezone: trigger.timezone ?? "UTC",
      }))
      .sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
  }

  function routineDefaultsHash(
    routine: Pick<
      BuiltInAgentBundleDefinition["routine"],
      "title" | "description" | "priority" | "concurrencyPolicy" | "catchUpPolicy" | "variables"
    >,
    triggers: Array<{
      kind: string;
      label?: string | null;
      cronExpression?: string | null;
      timezone?: string | null;
    }>,
  ) {
    return stockHash({
      title: routine.title,
      description: routine.description ?? "",
      priority: routine.priority,
      concurrencyPolicy: routine.concurrencyPolicy,
      catchUpPolicy: routine.catchUpPolicy,
      variables: normalizeRoutineVariablesForHash(routine),
      triggers: normalizeRoutineTriggersForHash(triggers),
    });
  }

  async function getRoutineByBinding(companyId: string, definition: BuiltInAgentDefinition) {
    const binding = await getManagedResourceBinding(companyId, definition.key, "routine", definition.bundle!.routine.routineKey);
    const routine = binding
      ? await db
        .select()
        .from(routines)
        .where(and(eq(routines.companyId, companyId), eq(routines.id, binding.resourceId)))
        .then((rows) => rows[0] as Routine | undefined ?? null)
      : await db
        .select()
        .from(routines)
        .where(and(
          eq(routines.companyId, companyId),
          eq(routines.originKind, "built_in_agent_bundle"),
          eq(routines.originId, `${definition.key}:${definition.bundle!.routine.routineKey}`),
        ))
        .then((rows) => rows[0] as Routine | undefined ?? null);
    const triggers = routine
      ? await db
        .select()
        .from(routineTriggers)
        .where(eq(routineTriggers.routineId, routine.id))
        .then((rows) => rows as RoutineTrigger[])
      : [];
    return { binding, routine, triggers };
  }

  function routineScheduleEnabled(routine: Routine | null, triggers: RoutineTrigger[]) {
    return Boolean(
      routine?.status === "active"
      && triggers.some((trigger) => trigger.kind === "schedule" && trigger.enabled),
    );
  }

  async function pendingUpdateProposal(agent: Agent | null) {
    if (!agent) return null;
    return db
      .select({
        interactionId: issueThreadInteractions.id,
        issueId: issues.id,
        issueIdentifier: issues.identifier,
      })
      .from(issueThreadInteractions)
      .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
      .where(and(
        eq(issueThreadInteractions.companyId, agent.companyId),
        eq(issueThreadInteractions.createdByAgentId, agent.id),
        eq(issueThreadInteractions.kind, "request_confirmation"),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  function withRoutineControls(
    state: BuiltInManagedResourceState,
    input: {
      routine: Routine | null;
      triggers: RoutineTrigger[];
      proposal: Awaited<ReturnType<typeof pendingUpdateProposal>>;
    },
  ) {
    if (state.resourceKind !== "routine") return state;
    return {
      ...state,
      scheduleEnabled: routineScheduleEnabled(input.routine, input.triggers),
      pendingUpdateInteractionId: input.proposal?.interactionId ?? null,
      pendingUpdateIssueId: input.proposal?.issueId ?? null,
      pendingUpdateIssueIdentifier: input.proposal?.issueIdentifier ?? null,
    };
  }

  async function requireBundleRoutine(companyId: string, key: string, routineKey: string) {
    const definition = requireBuiltInAgentDefinition(key);
    if (!definition.bundle || definition.bundle.routine.routineKey !== routineKey) {
      throw notFound("Built-in routine not found");
    }
    await ensureCompany(companyId);
    const agent = await findSingleAgent(companyId, definition);
    if (!agent) throw notFound("Built-in agent is not provisioned");
    const current = await getRoutineByBinding(companyId, definition);
    if (!current.routine) throw notFound("Built-in routine not found");
    const schedule = current.triggers.find((trigger) => trigger.kind === "schedule") ?? null;
    return { definition, agent, routine: current.routine, triggers: current.triggers, schedule };
  }

  async function ensureBuiltInAgentAssignable(agent: Agent) {
    if (agent.status !== "paused") return agent;
    const resumed = await agentSvc.resume(agent.id);
    if (!resumed) throw notFound("Built-in agent not found");
    return resumed as Agent;
  }

  async function createOrResetRoutine(agent: Agent, definition: BuiltInAgentDefinition, existing: Routine | null, mode: "reconcile" | "reset") {
    const routine = definition.bundle!.routine;
    const actor = { agentId: null, userId: "built-in-bundles" };
    const nextRoutine = existing
      ? await routineSvc.update(existing.id, {
        title: routine.title,
        description: routine.description,
        assigneeAgentId: agent.id,
        priority: routine.priority,
        status: routine.status,
        concurrencyPolicy: routine.concurrencyPolicy,
        catchUpPolicy: routine.catchUpPolicy,
        variables: routine.variables,
      }, actor)
      : await routineSvc.create(agent.companyId, {
        title: routine.title,
        description: routine.description,
        assigneeAgentId: agent.id,
        priority: routine.priority,
        status: routine.status,
        concurrencyPolicy: routine.concurrencyPolicy,
        catchUpPolicy: routine.catchUpPolicy,
        variables: routine.variables,
      }, actor);
    if (!nextRoutine) throw notFound("Built-in routine not found");
    await db
      .update(routines)
      .set({
        originKind: "built_in_agent_bundle",
        originId: `${definition.key}:${routine.routineKey}`,
        updatedAt: new Date(),
      })
      .where(eq(routines.id, nextRoutine.id));

    const currentTriggers = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.routineId, nextRoutine.id))
      .then((rows) => rows as RoutineTrigger[]);
    const firstSchedule = currentTriggers.find((trigger) => trigger.kind === "schedule");
    const stockTrigger = routine.triggers[0];
    if (stockTrigger && firstSchedule) {
      await routineSvc.updateTrigger(firstSchedule.id, {
        label: stockTrigger.label,
        enabled: stockTrigger.enabled,
        cronExpression: stockTrigger.cronExpression,
        timezone: stockTrigger.timezone,
      }, actor);
    } else if (stockTrigger) {
      await routineSvc.createTrigger(nextRoutine.id, {
        kind: "schedule",
        label: stockTrigger.label,
        enabled: stockTrigger.enabled,
        cronExpression: stockTrigger.cronExpression,
        timezone: stockTrigger.timezone,
      }, actor);
    }
    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "system",
      actorId: "built-in-bundles",
      action: mode === "reset" ? "built_in_agent.routine_reset" : "built_in_agent.routine_reconciled",
      entityType: "routine",
      entityId: nextRoutine.id,
      details: {
        key: definition.key,
        routineKey: routine.routineKey,
        status: routine.status,
      },
    });
    return nextRoutine;
  }

  async function materializeRoutine(agent: Agent, definition: BuiltInAgentDefinition, mode: "reconcile" | "reset") {
    const bundle = definition.bundle!;
    const stock = routineDefaultsHash(bundle.routine, bundle.routine.triggers);
    const { binding, routine, triggers } = await getRoutineByBinding(agent.companyId, definition);
    const currentHash = routine ? routineDefaultsHash({
      title: routine.title,
      description: routine.description ?? "",
      priority: routine.priority as "critical" | "high" | "medium" | "low",
      concurrencyPolicy: routine.concurrencyPolicy as "always_enqueue" | "coalesce_if_active" | "skip_if_active",
      catchUpPolicy: routine.catchUpPolicy as "enqueue_missed_with_cap" | "skip_missed",
      variables: routine.variables ?? [],
    }, triggers) : null;
    const currentState = stockState({
      resourceKind: "routine",
      resourceKey: bundle.routine.routineKey,
      resourceId: routine?.id ?? null,
      stockVersion: bundle.stockVersion,
      latestStockHash: stock,
      currentHash,
      bindingStockHash: binding?.stockHash ?? null,
    });
    const shouldWrite =
      mode === "reset"
      || currentState.stockStatus === "missing"
      || currentState.stockStatus === "stock_update_available";
    const nextRoutine = shouldWrite
      ? await createOrResetRoutine(agent, definition, routine, mode)
      : routine!;
    await upsertManagedResourceBinding({
      companyId: agent.companyId,
      bundleKey: definition.key,
      resourceKind: "routine",
      resourceKey: bundle.routine.routineKey,
      resourceId: nextRoutine.id,
      stockVersion: bundle.stockVersion,
      stockHash: shouldWrite ? stock : binding?.stockHash ?? stock,
      defaultsJson: {
        title: bundle.routine.title,
        status: bundle.routine.status,
        triggerCount: bundle.routine.triggers.length,
      },
    });
    const next = await getRoutineByBinding(agent.companyId, definition);
    return withRoutineControls(stockState({
      resourceKind: "routine",
      resourceKey: bundle.routine.routineKey,
      resourceId: nextRoutine.id,
      stockVersion: bundle.stockVersion,
      latestStockHash: stock,
      currentHash: shouldWrite ? stock : currentHash,
      bindingStockHash: shouldWrite ? stock : binding?.stockHash ?? stock,
    }), {
      routine: next.routine,
      triggers: next.triggers,
      proposal: await pendingUpdateProposal(agent),
    });
  }

  async function bundleResourceStates(companyId: string, definition: BuiltInAgentDefinition, agent: Agent | null) {
    if (!definition.bundle || !agent) return [];
    const bundle = definition.bundle;
    const [instructionBinding, skillBinding, routineBinding] = await Promise.all([
      getManagedResourceBinding(companyId, definition.key, "instructions", "AGENTS.md"),
      bundle.skill
        ? getManagedResourceBinding(companyId, definition.key, "skill", bundle.skill.skillKey)
        : Promise.resolve(null),
      getManagedResourceBinding(companyId, definition.key, "routine", bundle.routine.routineKey),
    ]);
    const instructionFiles = await currentInstructionFiles(agent, bundle);
    const skill = !bundle.skill
      ? null
      : skillBinding
        ? await skillSvc.getById(companyId, skillBinding.resourceId)
        : await skillSvc.getByKey(companyId, bundle.skill.canonicalKey);
    const skillFiles = await getCurrentSkillFiles(companyId, skill, bundle);
    const { routine, triggers } = await getRoutineByBinding(companyId, definition);
    const proposal = await pendingUpdateProposal(agent);
    const instructionHash = Object.values(instructionFiles).every((value) => value !== null)
      ? stockHash(instructionFiles)
      : null;
    const skillHash = skill && Object.values(skillFiles).every((value) => value !== null)
      ? stockHash(skillFiles)
      : null;
    const routineHash = routine ? routineDefaultsHash({
      title: routine.title,
      description: routine.description ?? "",
      priority: routine.priority as "critical" | "high" | "medium" | "low",
      concurrencyPolicy: routine.concurrencyPolicy as "always_enqueue" | "coalesce_if_active" | "skip_if_active",
      catchUpPolicy: routine.catchUpPolicy as "enqueue_missed_with_cap" | "skip_missed",
      variables: routine.variables ?? [],
    }, triggers) : null;
    return [
      stockState({
        resourceKind: "instructions",
        resourceKey: "AGENTS.md",
        resourceId: agent.id,
        stockVersion: bundle.stockVersion,
        latestStockHash: stockHash(bundle.instructions.files),
        currentHash: instructionHash,
        bindingStockHash: instructionBinding?.stockHash ?? null,
        changedFiles: changedFileList(instructionFiles, bundle.instructions.files),
      }),
      ...(bundle.skill
        ? [stockState({
          resourceKind: "skill" as const,
          resourceKey: bundle.skill.skillKey,
          resourceId: skill?.id ?? null,
          stockVersion: bundle.stockVersion,
          latestStockHash: stockHash(bundle.skill.files),
          currentHash: skillHash,
          bindingStockHash: skillBinding?.stockHash ?? null,
          changedFiles: changedFileList(skillFiles, bundle.skill.files),
        })]
        : []),
      withRoutineControls(stockState({
        resourceKind: "routine",
        resourceKey: bundle.routine.routineKey,
        resourceId: routine?.id ?? null,
        stockVersion: bundle.stockVersion,
        latestStockHash: routineDefaultsHash(bundle.routine, bundle.routine.triggers),
        currentHash: routineHash,
        bindingStockHash: routineBinding?.stockHash ?? null,
      }), { routine, triggers, proposal }),
    ];
  }

  async function reconcileBundleResources(
    agent: Agent,
    definition: BuiltInAgentDefinition,
    mode: "reconcile" | "reset",
    resources?: Array<"instructions" | "skill" | "routine">,
  ) {
    if (!definition.bundle) return [];
    const selected = new Set(resources ?? ["instructions", "skill", "routine"]);
    const existingStates = await bundleResourceStates(agent.companyId, definition, agent);
    const byKind = new Map(existingStates.map((state) => [state.resourceKind, state]));
    const instruction = selected.has("instructions")
      ? await materializeInstructions(agent, definition, mode)
      : byKind.get("instructions")!;
    const refreshedAgent = await agentSvc.getById(agent.id) as Agent | null;
    if (!refreshedAgent) throw notFound("Built-in agent not found");
    const skill = !definition.bundle.skill
      ? null
      : selected.has("skill")
        ? await materializeSkill(refreshedAgent, definition, mode)
        : byKind.get("skill")!;
    const refreshedAfterSkill = await agentSvc.getById(agent.id) as Agent | null;
    if (!refreshedAfterSkill) throw notFound("Built-in agent not found");
    const routine = selected.has("routine")
      ? await materializeRoutine(refreshedAfterSkill, definition, mode)
      : byKind.get("routine")!;
    return skill ? [instruction, skill, routine] : [instruction, routine];
  }

  async function ensureCompany(companyId: string) {
    const company = await db
      .select({
        id: companies.id,
        requireBoardApprovalForNewAgents: companies.requireBoardApprovalForNewAgents,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");
    return company;
  }

  async function findMarkedRows(companyId: string, key: string) {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    return rows
      .filter((row) => rowIsBuiltInAgent(row, key))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  }

  async function findSingleAgent(companyId: string, definition: BuiltInAgentDefinition) {
    const markedRows = await findMarkedRows(companyId, definition.key);
    if (markedRows.length > 1) {
      throw conflict(`Multiple built-in agents found for ${definition.key}`, {
        code: "built_in_agent_duplicate_instance",
        key: definition.key,
        agentIds: markedRows.map((row) => row.id),
      });
    }
    if (markedRows.length === 0) return null;
    const agent = await agentSvc.getById(markedRows[0]!.id);
    return agent as Agent | null;
  }

  async function state(
    definition: BuiltInAgentDefinition,
    agent: Agent | null,
    resources?: BuiltInManagedResourceState[],
  ): Promise<BuiltInAgentState> {
    return {
      definition,
      status: deriveBuiltInAgentStatus(agent),
      agentId: agent?.id ?? null,
      agent,
      pauseReason: agent?.pauseReason ?? null,
      resources: resources ?? await bundleResourceStates(agent?.companyId ?? "", definition, agent),
    };
  }

  async function get(companyId: string, key: string) {
    const definition = requireBuiltInAgentDefinition(key);
    await ensureCompany(companyId);
    return state(definition, await findSingleAgent(companyId, definition));
  }

  async function ensure(companyId: string, key: string, input: BuiltInAgentProvisionInput = {}) {
    const definition = requireBuiltInAgentDefinition(key);
    await ensureCompany(companyId);
    // Before any agent write: the slots its env references must exist, or the
    // write fails resolving them. See ensureDeclaredUserSecrets.
    await ensureDeclaredUserSecrets(companyId, definition);
    const existing = await findSingleAgent(companyId, definition);
    const existingPendingApproval = existing?.status === "pending_approval";
    const preserveExistingAdapter = Boolean(
      existing
      && !existingPendingApproval
      && input.adapterType === undefined
      && input.adapterConfig === undefined
      && hasCompleteAdapterConfig(existing.adapterType, existing.adapterConfig),
    );
    const resolvedInput = existingPendingApproval || preserveExistingAdapter
      ? input
      : await defaultProvisionInput(companyId, definition, input);
    if (existing) {
      const patch: Partial<typeof agents.$inferInsert> = {
        metadata: builtInMetadata(definition, existing.metadata),
      };
      if (
        !existingPendingApproval
        && (resolvedInput.adapterType !== undefined || resolvedInput.adapterConfig !== undefined)
      ) {
        const adapterType = resolvedInput.adapterType ?? existing.adapterType;
        assertAdapterAllowed(definition, adapterType);
        patch.adapterType = adapterType;
        patch.adapterConfig = withDefaultAdapterEnv(
          definition,
          (resolvedInput.adapterConfig ?? existing.adapterConfig) as Record<string, unknown>,
        );
      } else if (!existingPendingApproval && definition.defaultAdapterEnv) {
        // The definition declares secret references and this reconcile touched
        // no adapter fields — fill in only the references that are absent, so a
        // company that has never opened the agent's setup screen still ends up
        // with a DECLARED need (surfaced as "this secret is missing") rather
        // than a run that fails obscurely inside a tool.
        const merged = withDefaultAdapterEnv(definition, existing.adapterConfig as Record<string, unknown>);
        if (JSON.stringify(merged) !== JSON.stringify(existing.adapterConfig)) {
          patch.adapterConfig = merged;
        }
      }
      if (!existingPendingApproval && resolvedInput.budgetMonthlyCents !== undefined) {
        patch.budgetMonthlyCents = resolvedInput.budgetMonthlyCents;
      }
      if (
        !existingPendingApproval
        && definition.defaultManager === "single_root_agent"
        && !existing.reportsTo
      ) {
        const reportsTo = await findSingleRootManager(companyId);
        if (reportsTo) patch.reportsTo = reportsTo;
      }
      const updated = await agentSvc.update(existing.id, patch, {
        allowBuiltInAgentMetadata: true,
        recordRevision: { source: "built-in-agent:ensure" },
      });
      if (!updated) throw notFound("Built-in agent not found");
      if (existingPendingApproval) {
        return state(definition, updated as Agent);
      }
      await ensureBuiltInAgentDefaultGrants(updated as Agent, definition);
      const resources = await reconcileBundleResources(updated as Agent, definition, "reconcile");
      return state(definition, await agentSvc.getById(existing.id) as Agent, resources);
    }

    const reportsTo = definition.defaultManager === "single_root_agent"
      ? await findSingleRootManager(companyId)
      : null;
    const created = await agentSvc.create(companyId, {
      ...definitionPatch(definition, resolvedInput),
      status: definition.defaultStatus ?? "idle",
      pauseReason: definition.defaultStatus === "paused" ? "Built-in Reflection Coach is disabled until explicitly configured." : null,
      pausedAt: definition.defaultStatus === "paused" ? new Date() : null,
      reportsTo,
      metadata: builtInMetadata(definition),
      runtimeConfig: {},
      permissions: definitionPermissions(definition),
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }, { allowBuiltInAgentMetadata: true }) as Agent;

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "built-in-agents",
      action: "built_in_agent.provisioned",
      entityType: "agent",
      entityId: created.id,
      details: {
        key: definition.key,
        featureKeys: definition.featureKeys,
        status: deriveBuiltInAgentStatus(created),
      },
    });

    await ensureBuiltInAgentDefaultGrants(created, definition);
    const resources = await reconcileBundleResources(created, definition, "reconcile");
    return state(definition, await agentSvc.getById(created.id) as Agent, resources);
  }

  async function provision(
    companyId: string,
    key: string,
    input: BuiltInAgentProvisionInput = {},
    actor: BuiltInAgentProvisionActor = {},
  ): Promise<BuiltInAgentProvisionResult> {
    const definition = requireBuiltInAgentDefinition(key);
    const company = await ensureCompany(companyId);
    if (!company.requireBoardApprovalForNewAgents) {
      return { state: await ensure(companyId, key, input), approval: null };
    }

    const existing = await findSingleAgent(companyId, definition);
    if (existing) {
      if (existing.status === "pending_approval") {
        if (hasProvisionSetupInput(input)) {
          throw conflict("Built-in agent setup is already pending board approval.", {
            code: "built_in_agent_pending_approval",
            key: definition.key,
            agentId: existing.id,
          });
        }
        const approval = await approvalSvc.findOpenHireApprovalForAgent(companyId, existing.id);
        return {
          state: await state(definition, existing),
          approval: approval as Approval | null,
        };
      }

      if (input.adapterType !== undefined || input.adapterConfig !== undefined) {
        throw conflict("Built-in agent adapter changes require board approval before they can be applied.", {
          code: "built_in_agent_reconfiguration_requires_approval",
          key: definition.key,
          agentId: existing.id,
        });
      }

      return { state: await state(definition, existing), approval: null };
    }

    await ensureDeclaredUserSecrets(companyId, definition);
    const reportsTo = definition.defaultManager === "single_root_agent"
      ? await findSingleRootManager(companyId)
      : null;
    const pending = await agentSvc.create(companyId, {
      ...definitionPatch(definition, input),
      status: "pending_approval",
      reportsTo,
      metadata: builtInMetadata(definition),
      runtimeConfig: {},
      permissions: definitionPermissions(definition),
      spentMonthlyCents: 0,
      lastHeartbeatAt: null,
    }, { allowBuiltInAgentMetadata: true }) as Agent;

    const approval = await approvalSvc.create(companyId, {
      type: "hire_agent",
      requestedByAgentId: actor.requestedByAgentId ?? null,
      requestedByUserId: actor.requestedByUserId ?? null,
      status: "pending",
      payload: {
        name: pending.name,
        role: pending.role,
        title: pending.title,
        icon: pending.icon,
        reportsTo: pending.reportsTo,
        capabilities: pending.capabilities,
        adapterType: pending.adapterType,
        adapterConfig: pending.adapterConfig,
        runtimeConfig: pending.runtimeConfig,
        permissions: pending.permissions,
        budgetMonthlyCents: pending.budgetMonthlyCents,
        metadata: pending.metadata,
        agentId: pending.id,
        sourceBuiltInAgentKey: definition.key,
        featureKeys: definition.featureKeys,
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      updatedAt: new Date(),
    }) as Approval;

    return { state: await state(definition, pending), approval };
  }

  async function list(companyId: string) {
    await ensureCompany(companyId);
    return Promise.all(DEFINITIONS.map(async (definition) => state(definition, await findSingleAgent(companyId, definition))));
  }

  /**
   * Carry the definition's permission DECISION onto an already-provisioned record.
   *
   * A definition change does not reach agents that were provisioned before it.
   * That drift is normally cosmetic; here it is not. `heartbeat.executeRun`
   * refuses to dispatch a run whose effective config states no
   * `dangerouslySkipPermissions`, so an agent seeded before its definition
   * gained a governed `adapterConfig` becomes UNRUNNABLE — which is exactly what
   * happened to Implementer and Specifier on the live board, while the two
   * seeded afterwards were fine.
   *
   * Fill the key ONLY when the record does not state it. An operator who set it
   * either way made a decision, and the dispatch guard's contract is about the
   * ABSENCE of a decision, not about which one was made — so reconciling over an
   * explicit choice would be the definition overruling a human, which is not
   * what a default means. Every other adapter key the operator set is preserved.
   */
  function reconciledAdapterConfig(
    definition: BuiltInAgentDefinition,
    existing: { adapterConfig?: Record<string, unknown> | null },
  ): { adapterConfig?: Record<string, unknown> } {
    const declared = definition.defaultAdapterConfig;
    if (!declared) return {};
    const current = existing.adapterConfig ?? {};
    if ("dangerouslySkipPermissions" in current) return {};
    return { adapterConfig: { ...current, ...declared } };
  }

  async function reconcileDefinitionDefaults(companyId: string, key: string) {
    const definition = requireBuiltInAgentDefinition(key);
    await ensureCompany(companyId);
    const existing = await findSingleAgent(companyId, definition);
    if (!existing) return state(definition, null);
    const patch = {
      name: definition.displayName,
      role: definition.defaultRole,
      title: definition.defaultTitle ?? null,
      icon: definition.defaultIcon ?? null,
      capabilities: definition.shortPurpose,
      // The declared run profile is a DEFAULT, so it is reconciled the same way
      // name/role are: the definition owns it, and an operator's other
      // permission keys on the record are preserved around it.
      permissions: { ...(existing.permissions ?? {}), ...definitionPermissions(definition) },
      metadata: builtInMetadata(definition, existing.metadata),
      ...reconciledAdapterConfig(definition, existing),
    };
    const updated = await agentSvc.update(existing.id, patch, {
      allowBuiltInAgentMetadata: true,
      recordRevision: { source: "built-in-agent:reconcile-defaults" },
    });
    if (!updated) throw notFound("Built-in agent not found");
    await ensureBuiltInAgentDefaultGrants(updated as Agent, definition);
    return state(definition, updated as Agent);
  }

  async function reset(companyId: string, key: string, input: { resources?: Array<"agent" | "instructions" | "skill" | "routine"> } = {}) {
    const definition = requireBuiltInAgentDefinition(key);
    const resetAgentDefaults = !input.resources || input.resources.includes("agent");
    const current = resetAgentDefaults
      ? await reconcileDefinitionDefaults(companyId, key)
      : await get(companyId, key);
    if (!current.agent || !definition.bundle) return current;
    const selectedBundleResources = input.resources?.filter(
      (resource): resource is "instructions" | "skill" | "routine" => resource !== "agent",
    );
    const resources = await reconcileBundleResources(
      current.agent,
      definition,
      "reset",
      input.resources ? selectedBundleResources ?? [] : undefined,
    );
    return state(definition, await agentSvc.getById(current.agent.id) as Agent, resources);
  }

  async function setRoutineSchedule(
    companyId: string,
    key: string,
    routineKey: string,
    enabled: boolean,
    actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
  ) {
    const { definition, agent, routine, schedule } = await requireBundleRoutine(companyId, key, routineKey);
    if (!schedule) throw notFound("Built-in routine schedule not found");
    if (enabled) {
      await ensureBuiltInAgentAssignable(agent);
      await routineSvc.update(routine.id, { status: "active" }, actor);
      await routineSvc.updateTrigger(schedule.id, { enabled: true }, actor);
    } else {
      await routineSvc.updateTrigger(schedule.id, { enabled: false }, actor);
      await routineSvc.update(routine.id, { status: "paused" }, actor);
    }
    return state(definition, await agentSvc.getById(agent.id) as Agent);
  }

  async function runRoutine(
    companyId: string,
    key: string,
    routineKey: string,
    actor: { agentId?: string | null; userId?: string | null; runId?: string | null } = {},
  ) {
    const { agent, routine } = await requireBundleRoutine(companyId, key, routineKey);
    await ensureBuiltInAgentAssignable(agent);
    return routineSvc.runRoutine(routine.id, { source: "manual" }, actor);
  }

  async function requireBuiltInAgent(companyId: string, key: string): Promise<RequiredBuiltInAgent> {
    const current = await get(companyId, key);
    if (!current.agent) throw builtInAgentNotConfiguredError(current);
    if (current.status === "ready") {
      return { definition: current.definition, agent: current.agent, warning: null };
    }
    if (current.status === "paused") {
      return {
        definition: current.definition,
        agent: current.agent,
        warning: {
          code: "built_in_agent_paused",
          key: current.definition.key,
          agentId: current.agent.id,
          message: `Built-in agent ${current.definition.key} is paused; scheduled/background work should be skipped.`,
          pauseReason: current.pauseReason,
        },
      };
    }
    throw builtInAgentNotConfiguredError(current);
  }

  /**
   * Provision every definition that ASKS to exist in a company by default.
   *
   * One flag decides it: `autoProvision`. A definition qualifies because a
   * seeded lifecycle's agent step names it, resolves its executor by roster key,
   * and holds the step if the agent is missing — so the agent must already be
   * there when the first ticket moves.
   *
   * The filter used to be `entry.bundle || entry.autoProvision`, which treated
   * SHIPPING CONTENT as consent to provision: any definition carrying
   * instructions, a skill or a routine got a record in every company whether or
   * not anything would ever commission it. A bundle says "here is what this
   * agent would be if you hired it"; it does not say "hire it". The one
   * definition that relied on the looser clause was the inherited
   * reflection-coach, which is now gone, so the tightening changes no roster
   * agent's behaviour — all four set `autoProvision: true` explicitly. What it
   * changes is the meaning: a future bundled definition has to opt in.
   *
   * (Name kept for its callers.)
   */
  async function autoProvisionBundledAgents(companyId: string) {
    const company = await ensureCompany(companyId);
    let autoEnsured = 0;
    let pendingApprovals = 0;
    for (const definition of DEFINITIONS.filter((entry) => entry.autoProvision)) {
      if (company.requireBoardApprovalForNewAgents) {
        const result = await provision(companyId, definition.key);
        if (result.approval) pendingApprovals += 1;
      } else {
        await ensure(companyId, definition.key);
      }
      autoEnsured += 1;
    }
    const defaultGrantsEnsured = await ensureCompanyDefaultAgentGrants(companyId);
    return { autoEnsured, pendingApprovals, defaultGrantsEnsured };
  }

  return {
    definitions: listBuiltInAgentDefinitions,
    get,
    ensure,
    provision,
    list,
    reset,
    enableRoutineSchedule: (
      companyId: string,
      key: string,
      routineKey: string,
      actor?: { agentId?: string | null; userId?: string | null; runId?: string | null },
    ) => setRoutineSchedule(companyId, key, routineKey, true, actor),
    disableRoutineSchedule: (
      companyId: string,
      key: string,
      routineKey: string,
      actor?: { agentId?: string | null; userId?: string | null; runId?: string | null },
    ) => setRoutineSchedule(companyId, key, routineKey, false, actor),
    runRoutine,
    requireBuiltInAgent,
    autoProvisionBundledAgents,
    ensureCompanyDefaultAgentGrants,
    reconcileDefinitionDefaults,
  };
}

export async function reconcileBuiltInAgentsOnStartup(db: Db) {
  const svc = builtInAgentService(db);
  const companyRows = await db
    .select({ id: companies.id })
    .from(companies);
  let autoEnsured = 0;
  let pendingApprovals = 0;
  let defaultGrantsEnsured = 0;
  for (const company of companyRows) {
    const result = await svc.autoProvisionBundledAgents(company.id);
    autoEnsured += result.autoEnsured;
    pendingApprovals += result.pendingApprovals;
    defaultGrantsEnsured += result.defaultGrantsEnsured;
  }
  const rows = await db
    .select({
      companyId: agents.companyId,
      metadata: agents.metadata,
      status: agents.status,
    })
    .from(agents)
    .where(ne(agents.status, "terminated"));
  const seen = new Set<string>();
  let scanned = 0;
  let reconciled = 0;
  let unknown = 0;
  let duplicates = 0;

  for (const row of rows) {
    const marker = readBuiltInAgentMarker(row.metadata);
    if (!marker) continue;
    scanned += 1;
    if (!getBuiltInAgentDefinition(marker.key)) {
      unknown += 1;
      continue;
    }
    const instanceKey = `${row.companyId}:${marker.key}`;
    if (seen.has(instanceKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(instanceKey);
    await svc.reconcileDefinitionDefaults(row.companyId, marker.key);
    reconciled += 1;
  }

  return { scanned, reconciled, unknown, duplicates, autoEnsured, pendingApprovals, defaultGrantsEnsured };
}
