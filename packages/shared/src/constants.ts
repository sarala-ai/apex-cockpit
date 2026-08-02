export const COMPANY_STATUSES = ["active", "paused", "archived"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_COMPANY_ATTACHMENT_MAX_BYTES = 1024 * 1024 * 1024;

export const DEPLOYMENT_MODES = ["local_trusted", "authenticated"] as const;
export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const DEPLOYMENT_EXPOSURES = ["private", "public"] as const;
export type DeploymentExposure = (typeof DEPLOYMENT_EXPOSURES)[number];

export const BIND_MODES = ["loopback", "lan", "tailnet", "custom"] as const;
export type BindMode = (typeof BIND_MODES)[number];

export const AUTH_BASE_URL_MODES = ["auto", "explicit"] as const;
export type AuthBaseUrlMode = (typeof AUTH_BASE_URL_MODES)[number];

export const AGENT_STATUSES = [
  "active",
  "paused",
  "idle",
  "running",
  "error",
  "pending_approval",
  "terminated",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const AGENT_ADAPTER_TYPES = [
  "process",
  "http",
  "claude_local",
  "codex_local",
  "cursor_cloud",
  "gemini_local",
  "grok_local",
  "hermes_gateway",
  "hermes_local",
  "opencode_local",
  "pi_local",
  "cursor",
  "openclaw_gateway",
] as const;
export type AgentAdapterType = (typeof AGENT_ADAPTER_TYPES)[number] | (string & {});

export const AGENT_ROLES = [
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "security",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "general",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  ceo: "CEO",
  cto: "CTO",
  cmo: "CMO",
  cfo: "CFO",
  security: "Security",
  engineer: "Engineer",
  designer: "Designer",
  pm: "PM",
  qa: "QA",
  devops: "DevOps",
  researcher: "Researcher",
  general: "General",
};

export const AGENT_DEFAULT_MAX_CONCURRENT_RUNS = 20;
export const WORKSPACE_BRANCH_ROUTINE_VARIABLE = "workspaceBranch";

// Config keys owned by Paperclip/company state rather than one concrete adapter.
// `paperclipSkillSync` is persisted in adapterConfig but must survive adapter swaps.
export const ADAPTER_AGNOSTIC_KEYS = [
  "env",
  "promptTemplate",
  "instructionsFilePath",
  "cwd",
  "timeoutSec",
  "graceSec",
  "bootstrapPromptTemplate",
  "paperclipSkillSync",
] as const;
export type AdapterAgnosticKey = (typeof ADAPTER_AGNOSTIC_KEYS)[number];

export const MODEL_PROFILE_KEYS = ["cheap"] as const;
export type ModelProfileKey = (typeof MODEL_PROFILE_KEYS)[number];

export const AGENT_ICON_NAMES = [
  "bot",
  "cpu",
  "brain",
  "zap",
  "rocket",
  "code",
  "terminal",
  "shield",
  "eye",
  "search",
  "wrench",
  "hammer",
  "lightbulb",
  "sparkles",
  "star",
  "heart",
  "flame",
  "bug",
  "cog",
  "database",
  "globe",
  "lock",
  "mail",
  "message-square",
  "file-code",
  "git-branch",
  "package",
  "puzzle",
  "target",
  "wand",
  "atom",
  "circuit-board",
  "radar",
  "swords",
  "telescope",
  "microscope",
  "crown",
  "gem",
  "hexagon",
  "pentagon",
  "fingerprint",
] as const;
export type AgentIconName = (typeof AGENT_ICON_NAMES)[number];

/**
 * Curated Lucide icon set for projects (PAP-68 part 3).
 *
 * The first entry, `"folder"`, is the default for any project without an
 * explicit icon. The remaining entries reuse much of the agent icon set plus a
 * handful of folder/structure icons that read well at small tile sizes.
 */
export const PROJECT_ICON_NAMES = [
  "folder",
  "rocket",
  "code",
  "terminal",
  "database",
  "globe",
  "package",
  "boxes",
  "box",
  "layers",
  "briefcase",
  "compass",
  "target",
  "flame",
  "zap",
  "star",
  "bug",
  "wrench",
  "hammer",
  "lightbulb",
  "sparkles",
  "shield",
  "lock",
  "search",
  "cog",
  "brain",
  "cpu",
  "git-branch",
  "file-code",
  "puzzle",
  "gem",
  "atom",
  "heart",
  "mail",
  "message-square",
  "crown",
  "radar",
  "telescope",
  "hexagon",
] as const;
export type ProjectIconName = (typeof PROJECT_ICON_NAMES)[number];

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const INBOX_MINE_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
] as const;
export const INBOX_MINE_ISSUE_STATUS_FILTER = INBOX_MINE_ISSUE_STATUSES.join(",");

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];
export const ISSUE_WORK_MODES = ["standard", "ask", "planning", "skill_test"] as const;
export type IssueWorkMode = (typeof ISSUE_WORK_MODES)[number];
export const ISSUE_HARNESS_KINDS = ["skill_test"] as const;
export type IssueHarnessKind = (typeof ISSUE_HARNESS_KINDS)[number];
export const MAX_ISSUE_REQUEST_DEPTH = 1024;

export const ISSUE_COMMENT_AUTHOR_TYPES = ["user", "agent", "system"] as const;
export type IssueCommentAuthorType = (typeof ISSUE_COMMENT_AUTHOR_TYPES)[number];

export const ISSUE_COMMENT_PRESENTATION_KINDS = ["message", "system_notice"] as const;
export type IssueCommentPresentationKind = (typeof ISSUE_COMMENT_PRESENTATION_KINDS)[number];

export const ISSUE_COMMENT_PRESENTATION_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type IssueCommentPresentationTone = (typeof ISSUE_COMMENT_PRESENTATION_TONES)[number];

export const ISSUE_COMMENT_METADATA_ROW_TYPES = [
  "text",
  "code",
  "key_value",
  "issue_link",
  "agent_link",
  "run_link",
] as const;
export type IssueCommentMetadataRowType = (typeof ISSUE_COMMENT_METADATA_ROW_TYPES)[number];

export function clampIssueRequestDepth(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_ISSUE_REQUEST_DEPTH, Math.max(0, Math.floor(value)));
}

export const ISSUE_THREAD_INTERACTION_KINDS = [
  "suggest_tasks",
  "ask_user_questions",
  "request_confirmation",
  "request_checkbox_confirmation",
] as const;
export type IssueThreadInteractionKind = (typeof ISSUE_THREAD_INTERACTION_KINDS)[number];

export const REQUEST_CHECKBOX_CONFIRMATION_OPTION_LIMIT = 200;

export const ISSUE_THREAD_INTERACTION_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "answered",
  "cancelled",
  "expired",
  "failed",
] as const;
export type IssueThreadInteractionStatus = (typeof ISSUE_THREAD_INTERACTION_STATUSES)[number];

export const ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES = [
  "none",
  "wake_assignee",
  "wake_assignee_on_accept",
] as const;
export type IssueThreadInteractionContinuationPolicy =
  (typeof ISSUE_THREAD_INTERACTION_CONTINUATION_POLICIES)[number];

export const TASK_WATCHDOG_PRODUCT_BUG_ORIGIN_KIND = "task_watchdog_product_bug";

export const ISSUE_ORIGIN_KINDS = [
  "manual",
  "routine_execution",
  "stale_active_run_evaluation",
  "harness_liveness_escalation",
  "issue_productivity_review",
  "stranded_issue_recovery",
  "task_watchdog",
  TASK_WATCHDOG_PRODUCT_BUG_ORIGIN_KIND,
] as const;
export type BuiltInIssueOriginKind = (typeof ISSUE_ORIGIN_KINDS)[number];
export type PluginIssueOriginKind = `plugin:${string}`;
export type IssueOriginKind = BuiltInIssueOriginKind | PluginIssueOriginKind;
export const ISSUE_WATCHDOG_DISCOVERY_KINDS = ["product_bug", "platform_bug"] as const;
export type IssueWatchdogDiscoveryKind = (typeof ISSUE_WATCHDOG_DISCOVERY_KINDS)[number];
export const ISSUE_SURFACE_VISIBILITIES = ["default", "plugin_operation"] as const;
export type IssueSurfaceVisibility = (typeof ISSUE_SURFACE_VISIBILITIES)[number];

export const ISSUE_RECOVERY_ACTION_KINDS = [
  "missing_disposition",
  "stranded_assigned_issue",
  "workspace_validation",
  "configuration_validation",
  "active_run_watchdog",
  "issue_graph_liveness",
] as const;
export type IssueRecoveryActionKind = (typeof ISSUE_RECOVERY_ACTION_KINDS)[number];

export const ISSUE_RECOVERY_ACTION_STATUSES = [
  "active",
  "escalated",
  "resolved",
  "cancelled",
] as const;
export type IssueRecoveryActionStatus = (typeof ISSUE_RECOVERY_ACTION_STATUSES)[number];

export const ISSUE_RECOVERY_ACTION_OWNER_TYPES = [
  "agent",
  "user",
  "board",
  "system",
] as const;
export type IssueRecoveryActionOwnerType = (typeof ISSUE_RECOVERY_ACTION_OWNER_TYPES)[number];

export const ISSUE_RECOVERY_ACTION_OUTCOMES = [
  "restored",
  "delegated",
  "false_positive",
  "blocked",
  "escalated",
  "cancelled",
] as const;
export type IssueRecoveryActionOutcome = (typeof ISSUE_RECOVERY_ACTION_OUTCOMES)[number];

export function pluginOperationIssueOriginKind(pluginKey: string): PluginIssueOriginKind {
  return `plugin:${pluginKey}:operation`;
}

export function isPluginOperationIssueOriginKind(originKind: string | null | undefined): boolean {
  return typeof originKind === "string" && /^plugin:[^:]+:operation(?::|$)/.test(originKind);
}

export const ISSUE_RELATION_TYPES = ["blocks"] as const;
export type IssueRelationType = (typeof ISSUE_RELATION_TYPES)[number];

export const ISSUE_TREE_CONTROL_MODES = ["pause", "resume", "cancel", "restore"] as const;
export type IssueTreeControlMode = (typeof ISSUE_TREE_CONTROL_MODES)[number];

export const ISSUE_TREE_HOLD_STATUSES = ["active", "released"] as const;
export type IssueTreeHoldStatus = (typeof ISSUE_TREE_HOLD_STATUSES)[number];

export const ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES = ["manual", "after_active_runs_finish"] as const;
export type IssueTreeHoldReleasePolicyStrategy = (typeof ISSUE_TREE_HOLD_RELEASE_POLICY_STRATEGIES)[number];

export const ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY = "continuation-summary" as const;
export const PIPELINE_CASE_BODY_DOCUMENT_KEY = "pipeline-case-body" as const;
export const PIPELINE_AUTOMATION_DEFAULT_TITLE_TEMPLATE = "{{pipeline_name}} / {{stage_name}}: {{case_title}}" as const;
export const SYSTEM_ISSUE_DOCUMENT_KEYS = [
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  PIPELINE_CASE_BODY_DOCUMENT_KEY,
] as const;
export type SystemIssueDocumentKey = (typeof SYSTEM_ISSUE_DOCUMENT_KEYS)[number];

const SYSTEM_ISSUE_DOCUMENT_KEY_SET = new Set<string>(SYSTEM_ISSUE_DOCUMENT_KEYS);

export function isSystemIssueDocumentKey(key: string): key is SystemIssueDocumentKey {
  return SYSTEM_ISSUE_DOCUMENT_KEY_SET.has(key);
}
export const ISSUE_REFERENCE_SOURCE_KINDS = ["title", "description", "comment", "document"] as const;
export type IssueReferenceSourceKind = (typeof ISSUE_REFERENCE_SOURCE_KINDS)[number];

export const DOCUMENT_ANNOTATION_THREAD_STATUSES = ["open", "resolved"] as const;
export type DocumentAnnotationThreadStatus = (typeof DOCUMENT_ANNOTATION_THREAD_STATUSES)[number];

export const DOCUMENT_ANNOTATION_ANCHOR_STATES = ["active", "stale", "orphaned"] as const;
export type DocumentAnnotationAnchorState = (typeof DOCUMENT_ANNOTATION_ANCHOR_STATES)[number];

export const DOCUMENT_ANNOTATION_ANCHOR_CONFIDENCES = [
  "exact",
  "duplicate",
  "fuzzy",
  "ambiguous",
  "missing",
] as const;
export type DocumentAnnotationAnchorConfidence =
  (typeof DOCUMENT_ANNOTATION_ANCHOR_CONFIDENCES)[number];

export const EXTERNAL_OBJECT_STATUS_CATEGORIES = [
  "unknown",
  "open",
  "waiting",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "closed",
  "archived",
  "auth_required",
  "unreachable",
] as const;
export type ExternalObjectStatusCategory = (typeof EXTERNAL_OBJECT_STATUS_CATEGORIES)[number];

export const EXTERNAL_OBJECT_STATUS_TONES = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "muted",
] as const;
export type ExternalObjectStatusTone = (typeof EXTERNAL_OBJECT_STATUS_TONES)[number];

export const EXTERNAL_OBJECT_LIVENESS_STATES = [
  "unknown",
  "fresh",
  "stale",
  "auth_required",
  "unreachable",
] as const;
export type ExternalObjectLivenessState = (typeof EXTERNAL_OBJECT_LIVENESS_STATES)[number];

export const EXTERNAL_OBJECT_MENTION_SOURCE_KINDS = [
  "title",
  "description",
  "comment",
  "document",
  "property",
  "plugin",
] as const;
export type ExternalObjectMentionSourceKind = (typeof EXTERNAL_OBJECT_MENTION_SOURCE_KINDS)[number];

export const EXTERNAL_OBJECT_MENTION_CONFIDENCES = ["exact", "likely", "possible"] as const;
export type ExternalObjectMentionConfidence = (typeof EXTERNAL_OBJECT_MENTION_CONFIDENCES)[number];

export const ISSUE_EXECUTION_POLICY_MODES = ["normal", "auto"] as const;
export type IssueExecutionPolicyMode = (typeof ISSUE_EXECUTION_POLICY_MODES)[number];

export const ISSUE_EXECUTION_STAGE_TYPES = ["review", "approval"] as const;
export type IssueExecutionStageType = (typeof ISSUE_EXECUTION_STAGE_TYPES)[number];

export const ISSUE_MONITOR_SCHEDULED_BY = ["assignee", "board"] as const;
export type IssueMonitorScheduledBy = (typeof ISSUE_MONITOR_SCHEDULED_BY)[number];

export const ISSUE_EXECUTION_MONITOR_KINDS = ["external_service"] as const;
export type IssueExecutionMonitorKind = (typeof ISSUE_EXECUTION_MONITOR_KINDS)[number];

export const ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES = [
  "wake_owner",
  "create_recovery_issue",
  "escalate_to_board",
] as const;
export type IssueExecutionMonitorRecoveryPolicy =
  (typeof ISSUE_EXECUTION_MONITOR_RECOVERY_POLICIES)[number];

export const ISSUE_EXECUTION_STATE_STATUSES = ["idle", "pending", "changes_requested", "completed"] as const;
export type IssueExecutionStateStatus = (typeof ISSUE_EXECUTION_STATE_STATUSES)[number];

export const ISSUE_EXECUTION_MONITOR_STATE_STATUSES = ["scheduled", "triggered", "cleared"] as const;
export type IssueExecutionMonitorStateStatus = (typeof ISSUE_EXECUTION_MONITOR_STATE_STATUSES)[number];

export const ISSUE_EXECUTION_MONITOR_CLEAR_REASONS = [
  "manual",
  "triggered",
  "done",
  "cancelled",
  "invalid_status",
  "invalid_assignee",
  "dispatch_skipped",
  "timeout_exceeded",
  "max_attempts_exhausted",
] as const;
export type IssueExecutionMonitorClearReason = (typeof ISSUE_EXECUTION_MONITOR_CLEAR_REASONS)[number];

export const ISSUE_EXECUTION_DECISION_OUTCOMES = ["approved", "changes_requested"] as const;
export type IssueExecutionDecisionOutcome = (typeof ISSUE_EXECUTION_DECISION_OUTCOMES)[number];

// "initiative" sits directly under "company": in the product-engineering noun
// chain (idea → initiative → project → task) it is the object that carries a
// budget, a stop condition and — sometimes — a hypothesis. The other levels are
// org-scope goals and keep exactly the meaning they had.
export const GOAL_LEVELS = ["company", "initiative", "team", "agent", "task"] as const;
export type GoalLevel = (typeof GOAL_LEVELS)[number];

export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

/**
 * How an initiative ended. Deliberately NOT folded into `GOAL_STATUSES`:
 * "achieved"/"cancelled" already carry a meaning for company/team/agent/task
 * goals, and the four initiative closures are a different kind of statement —
 * a verdict about what was learned, not a state the object sits in. Keeping
 * them apart means the status picker at every other level stays honest, and a
 * closed initiative can still say which lifecycle state it closed *from*.
 *
 * Only meaningful when `level === "initiative"`; null everywhere else.
 */
export const GOAL_CLOSURES = ["validated", "stopped", "revised", "expired"] as const;
export type GoalClosure = (typeof GOAL_CLOSURES)[number];

/** Which discipline an initiative assumption belongs to. */
export const GOAL_ASSUMPTION_TYPES = [
  "technical",
  "regulatory",
  "commercial",
  "operational",
] as const;
export type GoalAssumptionType = (typeof GOAL_ASSUMPTION_TYPES)[number];

/** Where an assumption stands: untested, retired (answered), or blocked. */
export const GOAL_ASSUMPTION_STATUSES = ["untested", "retired", "blocked"] as const;
export type GoalAssumptionStatus = (typeof GOAL_ASSUMPTION_STATUSES)[number];

/**
 * Where a validation criterion stands.
 *
 * `never_registered` is the one that earns its place. APEX pre-registered ~40
 * numbered success criteria across 21 specs and reported against none of them;
 * an imported historical initiative must be able to say *that*, out loud, on
 * the record. Without the value the only honest alternative is an empty list,
 * which reads as "we did not need criteria" rather than "we wrote them and
 * never looked". Absence is reported, never omitted
 * (docs/architecture/initiative-discipline.md §4a).
 */
export const GOAL_CRITERION_STATUSES = [
  "pending",
  "hit",
  "missed",
  "never_registered",
] as const;
export type GoalCriterionStatus = (typeof GOAL_CRITERION_STATUSES)[number];

/** Only these two transitions are a *report*; the other statuses are states. */
export const GOAL_CRITERION_VERDICTS = ["hit", "missed"] as const;
export type GoalCriterionVerdict = (typeof GOAL_CRITERION_VERDICTS)[number];

/**
 * Where a hypothesis stands. The three answers come straight from the model
 * doc's hypothesis lifecycle (stated → testing → answered, closing as
 * supported · falsified · inconclusive); `untested` is the state before any of
 * them.
 *
 * This is a vocabulary and not prose because the fourteen hypotheses APEX
 * carried were folded into ten free-text fields, three of which held two or
 * three questions in one string with their verdicts written as sentences.
 * "Falsified" buried mid-paragraph is not a queryable answer, and a falsified
 * hypothesis is supposed to be a permanent one.
 */
export const GOAL_HYPOTHESIS_VERDICTS = [
  "untested",
  "supported",
  "falsified",
  "inconclusive",
] as const;
export type GoalHypothesisVerdict = (typeof GOAL_HYPOTHESIS_VERDICTS)[number];

/**
 * How an initiative's record came to exist. `confirmed` = a person said so or
 * it was read from something someone wrote down; `inferred` = reconstructed
 * from commits, releases or resources. The shaping agent weights them
 * differently — confirmed history is prior art it may rely on, inferred
 * history is a hypothesis about the past it must raise as a question — so this
 * has to be a field, not a sentence in the description that no reader can
 * parse (product-engineering.md, "Provenance on the reconstruction itself").
 */
export const GOAL_PROVENANCE_KINDS = ["confirmed", "inferred"] as const;
export type GoalProvenanceKind = (typeof GOAL_PROVENANCE_KINDS)[number];

// "on_hold" is the state a real portfolio spends most of its time in: valid,
// decided, not now. Without it a deprioritised project has to masquerade as
// cancelled (a lie about the decision) or in_progress (a lie about the work).
// "backlog" already carries not-started — it is the create default and reads
// correctly — so no separate not_started value is added.
// Where a release sits in its lifecycle. Separate from RELEASE_CLOSURES for the
// same reason goals keep `status` and `closure` apart: "observing" is a
// position, "rolled_back" is a verdict, and one column cannot carry both.
export const RELEASE_STATUSES = ["planned", "building", "released", "observing"] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

// How a release ended. `partially_reverted` is not a hedge — it is the honest
// answer when one initiative's change in a shared release was pulled and the
// rest stayed, and it is exactly the case that makes measurement unclean.
export const RELEASE_CLOSURES = [
  "stable",
  "rolled_back",
  "superseded",
  "partially_reverted",
] as const;
export type ReleaseClosure = (typeof RELEASE_CLOSURES)[number];

// "built" is delivered-but-never-exercised: the code exists, nothing has run
// through it against a real case. Four of APEX's own projects (apex-eval, the
// Observe pillar, the GCP observability provider, the observability skill pack)
// sat in `in_progress` for months because the only alternative — `completed` —
// would have claimed something nobody had checked. Delivered is not validated
// (docs/architecture/initiative-discipline.md §4) is the sentence the whole
// discipline turns on, and until now the project row could not say it.
// `completed` therefore means built AND exercised; `built` means built only.
//
// "folded" is the third project closure the model doc has always listed
// (product-engineering.md: "delivered · cancelled · folded into another
// project") and the schema never had. "Skill packs as the moat" folded into
// another initiative and had to be recorded as `cancelled` with prose — which
// says the work was abandoned when in fact it continues somewhere named. The
// `folded_into_project_id` / `folded_into_goal_id` columns carry the name.
export const PROJECT_STATUSES = [
  "backlog",
  "planned",
  "in_progress",
  "on_hold",
  "built",
  "completed",
  "folded",
  "cancelled",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Project statuses that mean the building is done. `built` is here and
 * `completed` is here; the difference between them is exercise, not delivery,
 * and it is reported as a count rather than by withholding delivery.
 */
export const PROJECT_DELIVERED_STATUSES = ["built", "completed"] as const;

/**
 * Terminal statuses that take a project out of the live set: nothing more will
 * be built under this project, here. They are NOT interchangeable — `cancelled`
 * abandons a stated outcome, `folded` moves it somewhere named — which is why
 * the derived reading treats them differently and the board counts them apart.
 */
export const PROJECT_CLOSED_OUT_STATUSES = ["cancelled", "folded"] as const;

/**
 * An initiative's status is READ FROM ITS PROJECTS, never stored. "Active — one
 * of four projects delivered, three on hold" is the honest reading, and a
 * stored label drifts the moment a project moves. Contrast `GOAL_CLOSURES`,
 * which a person sets deliberately: closure is a decision, status is a
 * consequence.
 */
/**
 * `partial` is the value that stops the board overstating. APEX's MCP-first
 * initiative had two failed projects recorded as `cancelled` and one that
 * shipped; because cancelled projects drop out of the live set, the derivation
 * read `delivered` for an initiative whose own sentence — every interface
 * generated from MCP tools — was falsified. `partial` says: everything still
 * standing was built, and something was abandoned along the way. The counts
 * beside it say how much.
 *
 * `on_hold` can now also be ASSERTED rather than derived, via the `hold`
 * marker on the goal — see `deriveInitiativeStatus`.
 */
export const INITIATIVE_DERIVED_STATUSES = [
  "planned",
  "active",
  "on_hold",
  "partial",
  "delivered",
  "cancelled",
] as const;
export type InitiativeDerivedStatus = (typeof INITIATIVE_DERIVED_STATUSES)[number];

export const ENVIRONMENT_DRIVERS = ["local", "ssh", "sandbox", "plugin"] as const;
export type EnvironmentDriver = (typeof ENVIRONMENT_DRIVERS)[number];

export const ENVIRONMENT_STATUSES = ["active", "archived"] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export const ENVIRONMENT_LEASE_STATUSES = ["active", "released", "expired", "failed", "retained", "pending_cleanup"] as const;
export type EnvironmentLeaseStatus = (typeof ENVIRONMENT_LEASE_STATUSES)[number];

export const ENVIRONMENT_LEASE_POLICIES = [
  "ephemeral",
  "reuse_by_environment",
  "reuse_by_execution_workspace",
  "retain_on_failure",
] as const;
export type EnvironmentLeasePolicy = (typeof ENVIRONMENT_LEASE_POLICIES)[number];

export const ENVIRONMENT_LEASE_CLEANUP_STATUSES = ["pending", "success", "failed"] as const;
export type EnvironmentLeaseCleanupStatus = (typeof ENVIRONMENT_LEASE_CLEANUP_STATUSES)[number];

export const ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_KINDS = [
  "snapshot",
  "image",
  "provider_template",
  "unknown",
] as const;
export type EnvironmentCustomImageTemplateKind = (typeof ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_KINDS)[number];

export const ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_STATUSES = [
  "active",
  "superseded",
  "revoked",
  "failed",
] as const;
export type EnvironmentCustomImageTemplateStatus = (typeof ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_STATUSES)[number];

export const ENVIRONMENT_CUSTOM_IMAGE_SETUP_SESSION_STATUSES = [
  "starting",
  "waiting_for_user",
  "capturing",
  "promoted",
  "cancelled",
  "timed_out",
  "failed",
] as const;
export type EnvironmentCustomImageSetupSessionStatus =
  (typeof ENVIRONMENT_CUSTOM_IMAGE_SETUP_SESSION_STATUSES)[number];

export const ENVIRONMENT_CUSTOM_IMAGE_SETUP_CONNECTION_TYPES = [
  "ssh",
  "browser_terminal",
  "unknown",
] as const;
export type EnvironmentCustomImageSetupConnectionType =
  (typeof ENVIRONMENT_CUSTOM_IMAGE_SETUP_CONNECTION_TYPES)[number];

export const ROUTINE_STATUSES = ["active", "paused", "archived"] as const;
export type RoutineStatus = (typeof ROUTINE_STATUSES)[number];

export const ROUTINE_CONCURRENCY_POLICIES = ["coalesce_if_active", "always_enqueue", "skip_if_active"] as const;
export type RoutineConcurrencyPolicy = (typeof ROUTINE_CONCURRENCY_POLICIES)[number];

export const ROUTINE_CATCH_UP_POLICIES = ["skip_missed", "enqueue_missed_with_cap"] as const;
export type RoutineCatchUpPolicy = (typeof ROUTINE_CATCH_UP_POLICIES)[number];

export const ROUTINE_TRIGGER_KINDS = ["schedule", "webhook", "api"] as const;
export type RoutineTriggerKind = (typeof ROUTINE_TRIGGER_KINDS)[number];

export const ROUTINE_TRIGGER_SIGNING_MODES = ["bearer", "hmac_sha256", "github_hmac", "none"] as const;
export type RoutineTriggerSigningMode = (typeof ROUTINE_TRIGGER_SIGNING_MODES)[number];

export const ROUTINE_VARIABLE_TYPES = ["text", "textarea", "number", "boolean", "select", "date"] as const;
export type RoutineVariableType = (typeof ROUTINE_VARIABLE_TYPES)[number];

export const ROUTINE_RUN_STATUSES = [
  "received",
  "coalesced",
  "skipped",
  "issue_created",
  "completed",
  "failed",
 ] as const;
export type RoutineRunStatus = (typeof ROUTINE_RUN_STATUSES)[number];

export const ROUTINE_RUN_SOURCES = ["schedule", "manual", "api", "webhook"] as const;
export type RoutineRunSource = (typeof ROUTINE_RUN_SOURCES)[number];

export const PAUSE_REASONS = ["manual", "budget", "system", "company_archived"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const PROJECT_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#3b82f6", // blue
] as const;

export const APPROVAL_TYPES = [
  "hire_agent",
  "approve_ceo_strategy",
  "budget_override_required",
  "request_board_approval",
  // apex-tower (Task 2 §2b): a ticket-lifecycle HITL gate (spec/plan/pr review).
  "pipeline_gate",
  // NOTE: `criterion_review` is deliberately NOT here, for the same reason
  // `flow_gate` is not: it is minted by the criterion-review sweep, never by a
  // client. A caller able to create one could fabricate a review prompt — and
  // then resolve it — against a criterion nobody looked at, which is precisely
  // the failure the monitor exists to make impossible.
] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

export const APPROVAL_STATUSES = [
  "pending",
  "revision_requested",
  "approved",
  "rejected",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const SECRET_PROVIDERS = [
  "local_encrypted",
  "aws_secrets_manager",
  "gcp_secret_manager",
  "vault",
] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

export const SECRET_PROVIDER_CONFIG_STATUSES = [
  "ready",
  "warning",
  "coming_soon",
  "disabled",
] as const;
export type SecretProviderConfigStatus = (typeof SECRET_PROVIDER_CONFIG_STATUSES)[number];

export const SECRET_PROVIDER_CONFIG_HEALTH_STATUSES = [
  "ready",
  "warning",
  "error",
  "coming_soon",
  "disabled",
] as const;
export type SecretProviderConfigHealthStatus =
  (typeof SECRET_PROVIDER_CONFIG_HEALTH_STATUSES)[number];

export const SECRET_STATUSES = ["active", "disabled", "archived", "deleted"] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

export const SECRET_SCOPES = ["company", "user"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export const SECRET_MANAGED_MODES = ["paperclip_managed", "external_reference"] as const;
export type SecretManagedMode = (typeof SECRET_MANAGED_MODES)[number];

export const SECRET_VERSION_STATUSES = [
  "current",
  "previous",
  "disabled",
  "destroyed",
  "failed",
] as const;
export type SecretVersionStatus = (typeof SECRET_VERSION_STATUSES)[number];

export const SECRET_BINDING_TARGET_TYPES = [
  "agent",
  "project",
  "environment",
  "routine",
  "plugin",
  "issue",
  "run",
  "system",
] as const;
export type SecretBindingTargetType = (typeof SECRET_BINDING_TARGET_TYPES)[number];

export const SECRET_ACCESS_OUTCOMES = [
  "success",
  "failure",
  "missing",
  "inactive",
  "not_allowed",
  "optional_omitted",
  "provider_error",
] as const;
export type SecretAccessOutcome = (typeof SECRET_ACCESS_OUTCOMES)[number];

export const STORAGE_PROVIDERS = ["local_disk", "s3"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

export const BILLING_TYPES = [
  "metered_api",
  "subscription_included",
  "subscription_overage",
  "credits",
  "fixed",
  "unknown",
] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const FINANCE_EVENT_KINDS = [
  "inference_charge",
  "platform_fee",
  "credit_purchase",
  "credit_refund",
  "credit_expiry",
  "byok_fee",
  "gateway_overhead",
  "log_storage_charge",
  "logpush_charge",
  "provisioned_capacity_charge",
  "training_charge",
  "custom_model_import_charge",
  "custom_model_storage_charge",
  "manual_adjustment",
] as const;
export type FinanceEventKind = (typeof FINANCE_EVENT_KINDS)[number];

export const FINANCE_DIRECTIONS = ["debit", "credit"] as const;
export type FinanceDirection = (typeof FINANCE_DIRECTIONS)[number];

export const FINANCE_UNITS = [
  "input_token",
  "output_token",
  "cached_input_token",
  "request",
  "credit_usd",
  "credit_unit",
  "model_unit_minute",
  "model_unit_hour",
  "gb_month",
  "train_token",
  "unknown",
] as const;
export type FinanceUnit = (typeof FINANCE_UNITS)[number];

export const BUDGET_SCOPE_TYPES = ["company", "agent", "project"] as const;
export type BudgetScopeType = (typeof BUDGET_SCOPE_TYPES)[number];

export const BUDGET_METRICS = ["billed_cents"] as const;
export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export const BUDGET_WINDOW_KINDS = ["calendar_month_utc", "lifetime"] as const;
export type BudgetWindowKind = (typeof BUDGET_WINDOW_KINDS)[number];

export const BUDGET_THRESHOLD_TYPES = ["soft", "hard"] as const;
export type BudgetThresholdType = (typeof BUDGET_THRESHOLD_TYPES)[number];

export const BUDGET_INCIDENT_STATUSES = ["open", "resolved", "dismissed"] as const;
export type BudgetIncidentStatus = (typeof BUDGET_INCIDENT_STATUSES)[number];

export const BUDGET_INCIDENT_RESOLUTION_ACTIONS = [
  "keep_paused",
  "raise_budget_and_resume",
] as const;
export type BudgetIncidentResolutionAction = (typeof BUDGET_INCIDENT_RESOLUTION_ACTIONS)[number];

export const HEARTBEAT_INVOCATION_SOURCES = [
  "timer",
  "assignment",
  "on_demand",
  "automation",
] as const;
export type HeartbeatInvocationSource = (typeof HEARTBEAT_INVOCATION_SOURCES)[number];

export const WAKEUP_TRIGGER_DETAILS = ["manual", "ping", "callback", "system"] as const;
export type WakeupTriggerDetail = (typeof WAKEUP_TRIGGER_DETAILS)[number];

export const WAKEUP_REQUEST_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "coalesced",
  "skipped",
  "completed",
  "failed",
  "cancelled",
] as const;
export type WakeupRequestStatus = (typeof WAKEUP_REQUEST_STATUSES)[number];

export const HEARTBEAT_RUN_STATUSES = [
  "queued",
  "scheduled_retry",
  "running",
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type HeartbeatRunStatus = (typeof HEARTBEAT_RUN_STATUSES)[number];

export const RUN_LIVENESS_STATES = [
  "completed",
  "advanced",
  "plan_only",
  "empty_response",
  "blocked",
  "failed",
  "needs_followup",
] as const;
export type RunLivenessState = (typeof RUN_LIVENESS_STATES)[number];

export const LIVE_EVENT_TYPES = [
  "heartbeat.run.queued",
  "heartbeat.run.status",
  "heartbeat.run.progress",
  "heartbeat.run.event",
  "heartbeat.run.log",
  "agent.status",
  "activity.logged",
  "external_object.updated",
  "plugin.ui.updated",
  "plugin.worker.crashed",
  "plugin.worker.restarted",
] as const;
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export const PRINCIPAL_TYPES = ["user", "agent"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export const MEMBERSHIP_STATUSES = ["pending", "active", "suspended", "archived"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const COMPANY_MEMBERSHIP_ROLES = [
  "owner",
  "admin",
  "operator",
  "viewer",
  "member",
] as const;
export type CompanyMembershipRole = (typeof COMPANY_MEMBERSHIP_ROLES)[number];

export const HUMAN_COMPANY_MEMBERSHIP_ROLES = [
  "owner",
  "admin",
  "operator",
  "viewer",
] as const;
export type HumanCompanyMembershipRole = (typeof HUMAN_COMPANY_MEMBERSHIP_ROLES)[number];

export const HUMAN_COMPANY_MEMBERSHIP_ROLE_LABELS: Record<HumanCompanyMembershipRole, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

export const INSTANCE_USER_ROLES = ["instance_admin"] as const;
export type InstanceUserRole = (typeof INSTANCE_USER_ROLES)[number];

export const INVITE_TYPES = ["company_join", "bootstrap_ceo"] as const;
export type InviteType = (typeof INVITE_TYPES)[number];

export const INVITE_JOIN_TYPES = ["human", "agent", "both"] as const;
export type InviteJoinType = (typeof INVITE_JOIN_TYPES)[number];

export const JOIN_REQUEST_TYPES = ["human", "agent"] as const;
export type JoinRequestType = (typeof JOIN_REQUEST_TYPES)[number];

export const JOIN_REQUEST_STATUSES = ["pending_approval", "approved", "rejected"] as const;
export type JoinRequestStatus = (typeof JOIN_REQUEST_STATUSES)[number];

export const PERMISSION_KEYS = [
  "agents:create",
  "agents:configure",
  "agents:suggest-changes",
  "skills:create",
  "skills:suggest-changes",
  "environments:manage",
  "users:invite",
  "users:manage_permissions",
  "tasks:assign",
  "tasks:assign_scope",
  "tasks:manage_active_checkouts",
  "pipelines:write",
  "joins:approve",
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

// ---------------------------------------------------------------------------
// Plugin System — see doc/plugins/PLUGIN_SPEC.md for the full specification
// ---------------------------------------------------------------------------

/**
 * The current version of the Plugin API contract.
 *
 * Increment this value whenever a breaking change is made to the plugin API
 * so that the host can reject incompatible plugin manifests.
 *
 * @see PLUGIN_SPEC.md §4 — Versioning
 */
export const PLUGIN_API_VERSION = 1 as const;

/**
 * Lifecycle statuses for an installed plugin.
 *
 * State machine: installed → ready | error, ready → disabled | error | upgrade_pending | uninstalled,
 * disabled → ready | uninstalled, error → ready | uninstalled,
 * upgrade_pending → ready | error | uninstalled, uninstalled → installed (reinstall).
 *
 * @see {@link PluginStatus} — inferred union type
 * @see PLUGIN_SPEC.md §21.3 `plugins.status`
 */
export const PLUGIN_STATUSES = [
  "installed",
  "ready",
  "disabled",
  "error",
  "upgrade_pending",
  "uninstalled",
] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/**
 * Plugin classification categories. A plugin declares one or more categories
 * in its manifest to describe its primary purpose.
 *
 * @see PLUGIN_SPEC.md §6.2
 */
export const PLUGIN_CATEGORIES = [
  "connector",
  "workspace",
  "automation",
  "ui",
] as const;
export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

/**
 * Named permissions the host grants to a plugin. Plugins declare required
 * capabilities in their manifest; the host enforces them at runtime via the
 * plugin capability validator.
 *
 * Grouped into: Data Read, Data Write, Plugin State, Runtime/Integration,
 * Agent Tools, and UI.
 *
 * @see PLUGIN_SPEC.md §15 — Capability Model
 */
export const PLUGIN_CAPABILITIES = [
  // Data Read
  "companies.read",
  "projects.read",
  "project.workspaces.read",
  "execution.workspaces.read",
  "issues.read",
  "issue.relations.read",
  "issue.subtree.read",
  "issue.comments.read",
  "issue.documents.read",
  "agents.read",
  "goals.read",
  "goals.create",
  "goals.update",
  "activity.read",
  "costs.read",
  "issues.orchestration.read",
  "access.members.read",
  "access.invites.read",
  "authorization.grants.read",
  "authorization.policies.read",
  "authorization.audit.read",
  "database.namespace.read",
  // Data Write
  "issues.create",
  "issues.update",
  "issue.relations.write",
  "issues.checkout",
  "issues.wakeup",
  "issue.comments.create",
  "issue.interactions.create",
  "issue.documents.write",
  "projects.managed",
  "routines.managed",
  "skills.managed",
  "agents.pause",
  "agents.resume",
  "agents.invoke",
  "agents.managed",
  "access.members.write",
  "access.invites.write",
  "authorization.grants.write",
  "authorization.policies.write",
  "agent.sessions.create",
  "agent.sessions.list",
  "agent.sessions.send",
  "agent.sessions.close",
  "activity.log.write",
  "metrics.write",
  "telemetry.track",
  "database.namespace.migrate",
  "database.namespace.write",
  "external.objects.detect",
  "external.objects.read",
  "external.objects.write",
  "external.objects.refresh",
  // Plugin State
  "plugin.state.read",
  "plugin.state.write",
  // Runtime / Integration
  "events.subscribe",
  "events.emit",
  "jobs.schedule",
  "webhooks.receive",
  "api.routes.register",
  "http.outbound",
  "secrets.read-ref",
  "environment.drivers.register",
  "local.folders",
  // Agent Tools
  "agent.tools.register",
  // UI
  "instance.settings.register",
  "ui.sidebar.register",
  "ui.page.register",
  "ui.detailTab.register",
  "ui.dashboardWidget.register",
  "ui.commentAnnotation.register",
  "ui.action.register",
] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

export const PLUGIN_DATABASE_NAMESPACE_MODES = ["schema"] as const;
export type PluginDatabaseNamespaceMode = (typeof PLUGIN_DATABASE_NAMESPACE_MODES)[number];

export const PLUGIN_DATABASE_NAMESPACE_STATUSES = [
  "active",
  "migration_failed",
] as const;
export type PluginDatabaseNamespaceStatus = (typeof PLUGIN_DATABASE_NAMESPACE_STATUSES)[number];

export const PLUGIN_DATABASE_MIGRATION_STATUSES = [
  "applied",
  "failed",
] as const;
export type PluginDatabaseMigrationStatus = (typeof PLUGIN_DATABASE_MIGRATION_STATUSES)[number];

export const PLUGIN_DATABASE_CORE_READ_TABLES = [
  "companies",
  "projects",
  "goals",
  "agents",
  "issues",
  "issue_documents",
  "issue_relations",
  "issue_comments",
  "heartbeat_runs",
  "cost_events",
  "approvals",
  "issue_approvals",
  "budget_incidents",
] as const;
export type PluginDatabaseCoreReadTable = (typeof PLUGIN_DATABASE_CORE_READ_TABLES)[number];

export const PLUGIN_API_ROUTE_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export type PluginApiRouteMethod = (typeof PLUGIN_API_ROUTE_METHODS)[number];

export const PLUGIN_API_ROUTE_AUTH_MODES = ["board", "agent", "board-or-agent", "webhook"] as const;
export type PluginApiRouteAuthMode = (typeof PLUGIN_API_ROUTE_AUTH_MODES)[number];

export const PLUGIN_API_ROUTE_CHECKOUT_POLICIES = [
  "none",
  "required-for-agent-in-progress",
  "always-for-agent",
] as const;
export type PluginApiRouteCheckoutPolicy = (typeof PLUGIN_API_ROUTE_CHECKOUT_POLICIES)[number];

/**
 * UI extension slot types. Each slot type corresponds to a mount point in the
 * Paperclip UI where plugin components can be rendered.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 */
export const PLUGIN_UI_SLOT_TYPES = [
  "page",
  "detailTab",
  "taskDetailView",
  "dashboardWidget",
  "sidebar",
  "routeSidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "globalToolbarButton",
  "toolbarButton",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "settingsPage",
  "companySettingsPage",
] as const;
export type PluginUiSlotType = (typeof PLUGIN_UI_SLOT_TYPES)[number];

export const WORKSPACE_OVERVIEW_DEFAULT_LIMIT = 50;
export const WORKSPACE_OVERVIEW_MAX_LIMIT = 100;
export const WORKSPACE_OVERVIEW_LINKED_ISSUE_LIMIT = 4;

/**
 * Reserved company-scoped route segments that plugin page routes may not claim.
 *
 * These map to first-class host pages under `/:companyPrefix/...`.
 */
export const PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS = [
  "dashboard",
  "onboarding",
  "companies",
  "company",
  "settings",
  "plugins",
  "org",
  "agents",
  "projects",
  "issues",
  "goals",
  "approvals",
  "costs",
  "activity",
  "inbox",
  "workspaces",
  "design-guide",
  "tests",
] as const;
export type PluginReservedCompanyRouteSegment =
  (typeof PLUGIN_RESERVED_COMPANY_ROUTE_SEGMENTS)[number];

/**
 * Reserved route segments under `/:companyPrefix/company/settings/...` that
 * plugin company settings pages may not claim.
 */
export const PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS = [
  "general",
  "environments",
  "access",
  "members",
  "invites",
  "secrets",
  "instance",
] as const;
export type PluginReservedCompanySettingsRouteSegment =
  (typeof PLUGIN_RESERVED_COMPANY_SETTINGS_ROUTE_SEGMENTS)[number];

/**
 * Launcher placement zones describe where a plugin-owned launcher can appear
 * in the host UI. These are intentionally aligned with current slot surfaces
 * so manifest authors can describe launch intent without coupling to a single
 * component implementation detail.
 */
export const PLUGIN_LAUNCHER_PLACEMENT_ZONES = [
  "page",
  "detailTab",
  "taskDetailView",
  "dashboardWidget",
  "sidebar",
  "sidebarPanel",
  "projectSidebarItem",
  "globalToolbarButton",
  "toolbarButton",
  "contextMenuItem",
  "commentAnnotation",
  "commentContextMenuItem",
  "settingsPage",
] as const;
export type PluginLauncherPlacementZone = (typeof PLUGIN_LAUNCHER_PLACEMENT_ZONES)[number];

/**
 * Launcher action kinds describe what the launcher does when activated.
 */
export const PLUGIN_LAUNCHER_ACTIONS = [
  "navigate",
  "openModal",
  "openDrawer",
  "openPopover",
  "performAction",
  "deepLink",
] as const;
export type PluginLauncherAction = (typeof PLUGIN_LAUNCHER_ACTIONS)[number];

/**
 * Optional size hints the host can use when rendering plugin-owned launcher
 * destinations such as overlays, drawers, or full page handoffs.
 */
export const PLUGIN_LAUNCHER_BOUNDS = [
  "inline",
  "compact",
  "default",
  "wide",
  "full",
] as const;
export type PluginLauncherBounds = (typeof PLUGIN_LAUNCHER_BOUNDS)[number];

/**
 * Render environments describe the container a launcher expects after it is
 * activated. The current host may map these to concrete UI primitives.
 */
export const PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS = [
  "hostInline",
  "hostOverlay",
  "hostRoute",
  "external",
  "iframe",
] as const;
export type PluginLauncherRenderEnvironment =
  (typeof PLUGIN_LAUNCHER_RENDER_ENVIRONMENTS)[number];

/**
 * Entity types that a `detailTab` UI slot can attach to.
 *
 * @see PLUGIN_SPEC.md §19.3 — Detail Tabs
 */
export const PLUGIN_UI_SLOT_ENTITY_TYPES = [
  "project",
  "issue",
  "agent",
  "goal",
  "run",
  "comment",
  "execution_workspace",
  "project_workspace",
] as const;
export type PluginUiSlotEntityType = (typeof PLUGIN_UI_SLOT_ENTITY_TYPES)[number];

/**
 * Scope kinds for plugin state storage. Determines the granularity at which
 * a plugin stores key-value state data.
 *
 * @see PLUGIN_SPEC.md §21.3 `plugin_state.scope_kind`
 */
export const PLUGIN_STATE_SCOPE_KINDS = [
  "instance",
  "company",
  "project",
  "project_workspace",
  "agent",
  "issue",
  "goal",
  "run",
] as const;
export type PluginStateScopeKind = (typeof PLUGIN_STATE_SCOPE_KINDS)[number];

/** Statuses for a plugin's scheduled job definition. */
export const PLUGIN_JOB_STATUSES = [
  "active",
  "paused",
  "failed",
] as const;
export type PluginJobStatus = (typeof PLUGIN_JOB_STATUSES)[number];

/** Statuses for individual job run executions. */
export const PLUGIN_JOB_RUN_STATUSES = [
  "pending",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type PluginJobRunStatus = (typeof PLUGIN_JOB_RUN_STATUSES)[number];

/** What triggered a particular job run. */
export const PLUGIN_JOB_RUN_TRIGGERS = [
  "schedule",
  "manual",
  "retry",
] as const;
export type PluginJobRunTrigger = (typeof PLUGIN_JOB_RUN_TRIGGERS)[number];

/** Statuses for inbound webhook deliveries. */
export const PLUGIN_WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "success",
  "failed",
] as const;
export type PluginWebhookDeliveryStatus = (typeof PLUGIN_WEBHOOK_DELIVERY_STATUSES)[number];

/**
 * Core domain event types that plugins can subscribe to via the
 * `events.subscribe` capability.
 *
 * @see PLUGIN_SPEC.md §16 — Event System
 */
export const PLUGIN_EVENT_TYPES = [
  "company.created",
  "company.updated",
  "project.created",
  "project.updated",
  "project.workspace_created",
  "project.workspace_updated",
  "project.workspace_deleted",
  "issue.created",
  "issue.updated",
  "issue.comment.created",
  "issue.document.created",
  "issue.document.updated",
  "issue.document.deleted",
  "issue.relations.updated",
  "issue.checked_out",
  "issue.released",
  "issue.assignment_wakeup_requested",
  "agent.created",
  "agent.updated",
  "agent.status_changed",
  "agent.error_cleared",
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
  "goal.created",
  "goal.updated",
  "approval.created",
  "approval.decided",
  "budget.incident.opened",
  "budget.incident.resolved",
  "cost_event.created",
  "activity.logged",
] as const;
export type PluginEventType = (typeof PLUGIN_EVENT_TYPES)[number];

/**
 * Error codes returned by the plugin bridge when a UI → worker call fails.
 *
 * @see PLUGIN_SPEC.md §19.7 — Error Propagation Through The Bridge
 */
export const PLUGIN_BRIDGE_ERROR_CODES = [
  "WORKER_UNAVAILABLE",
  "CAPABILITY_DENIED",
  "INVOCATION_SCOPE_DENIED",
  "WORKER_ERROR",
  "TIMEOUT",
  "UNKNOWN",
] as const;
export type PluginBridgeErrorCode = (typeof PLUGIN_BRIDGE_ERROR_CODES)[number];
