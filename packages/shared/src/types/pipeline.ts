import type { Issue } from "./issue.js";
import type { RoutineEnvConfig } from "./routine.js";
import type { ExecutionWorkspaceMode, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { SourceTrustMetadata } from "../trust-policy.js";

export type PipelineCaseConversationSourceReason =
  | "producer_update"
  | "producer_create"
  | "automation_link"
  | "conversation_link"
  | "work_link";

export type PipelineCaseConversationSourceLinkRole = "automation" | "conversation" | "work";
export type PipelineCaseConversationSourceKind =
  | "explicit_conversation"
  | "own_producer"
  | "inherited_parent_producer";

export interface PipelineCaseConversationSource {
  issue: Issue;
  kind: PipelineCaseConversationSourceKind;
  isActive: boolean;
  reason: PipelineCaseConversationSourceReason;
  linkRole?: PipelineCaseConversationSourceLinkRole | null;
  sourceRunId?: string | null;
}

export interface PipelineStageAutomation {
  routineId: string;
  assigneeAgentId: string | null;
  titleTemplate: string;
  instructionsBody: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: ExecutionWorkspaceMode | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  env: RoutineEnvConfig | null;
  latestRoutineRevisionId: string | null;
  latestRoutineRevisionNumber: number;
}

export type PipelineCaseLivenessState = "terminal" | "live" | "waiting" | "blocked" | "attention";

export interface PipelineCaseLiveness {
  state: PipelineCaseLivenessState;
  reason:
    | "terminal"
    | "lease_active"
    | "linked_issue_active"
    | "linked_issue_waiting"
    | "linked_issue_blocked"
    | "case_blocked"
    | "automation_failed"
    | "permission_preflight_failed"
    | "breakdown_pending"
    | "breakdown_incomplete"
    | "children_waiting"
    | "review_waiting"
    | "step_running"
    | "step_held"
    | "no_action_path";
  message: string;
  issue?: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
  } | null;
  blocker?: {
    caseId?: string | null;
    issueId?: string | null;
    title?: string | null;
    status?: string | null;
    terminalKind?: string | null;
  } | null;
  automation?: {
    automationId?: string | null;
    routineId?: string | null;
    executionId?: string | null;
    error?: string | null;
    fingerprint?: string | null;
  } | null;
  breakdown?: {
    expectedRequestKeys?: string[];
    createdRequestKeys?: string[];
    missingRequestKeys?: string[];
  } | null;
  /** Present when a step stopped and the process will not move on until
   *  somebody deals with it. See {@link PipelineStepHold}. */
  hold?: PipelineStepHold | null;
}

/**
 * A step that stopped, and the recorded reason it stopped.
 *
 * The server has always known this — it writes the fact the moment a step
 * fails, and every transition out of the step is refused because of it. What
 * it never did was hand it to a surface a person reads. This is that hand-off:
 * the raw facts, translated into words by the client (`ui/src/lib/step-hold`)
 * so one wording serves the ticket and the item page alike.
 */
export interface PipelineStepHold {
  /** The recorded event, so a surface can link to it or dedupe on it. */
  eventId: string;
  stageId: string | null;
  stageKey: string | null;
  /** The name the process gave this step, when the caller could resolve it. */
  stageName?: string | null;
  /** Which machinery stopped: `run_exit_failure`, `agent_step_failure`,
   *  `acceptance_failed`, `step_exit_transition_blocked`. Drives the wording,
   *  never shown raw. */
  reason: string | null;
  errorType: string | null;
  /** The sentence the server recorded about this specific failure. Shown
   *  verbatim — it is the only part that says what actually happened. */
  message: string | null;
  heldAt: string;
}

/**
 * A stopped step as the attention surfaces read it.
 *
 * The count on the sidebar and the tile on the dashboard both need a list you
 * can open, and that list has to name the ticket rather than the case: a
 * person recognises "APEX-14", not a case key. Words are still the client's
 * (`ui/src/lib/step-hold`) — this only carries the facts.
 */
export interface PipelineStoppedStep {
  caseId: string;
  caseKey: string;
  pipelineId: string;
  /** The step's own display name, so a surface never has to humanise a key. */
  stageName: string;
  /** The ticket this stopped on, when a live one points at it. */
  issue: {
    id: string;
    identifier: string | null;
    title: string;
  } | null;
  /** The human answerable for it: the ticket's, else whoever raised it, else
   *  the company's default. Never the agent that was running the step. */
  responsibleUserId: string | null;
  /** True when that human is the one asking. */
  isMine: boolean;
  hold: PipelineStepHold;
}

export type PipelineAutomationRetryScope = "current_stage" | "previous_stage";

export interface PipelineAutomationRetryCleanupOptions {
  retireDirectChildren: boolean;
  retireDescendants: boolean;
  cancelLinkedAutomationIssues: boolean;
}

export interface PipelineAutomationRetryStageRef {
  id: string;
  key: string;
  name: string;
}

export interface PipelineAutomationRetryRoutineRef {
  id: string;
  title: string;
  assigneeAgentId: string | null;
  assigneeAgent: {
    id: string;
    name: string;
    role: string;
    title: string | null;
  } | null;
}

export interface PipelineAutomationRetryEffectCounts {
  directChildren: number;
  descendants: number;
  linkedAutomationIssues: number;
  activeDescendants: number;
  unresolvedBlockers: number;
}

export interface PipelineAutomationRetryBlocker {
  kind:
    | "automation_not_configured"
    | "previous_stage_not_found"
    | "target_stage_not_eligible"
    | "target_case_terminal"
    | "target_pipeline_archived"
    | "active_descendants"
    | "unresolved_blockers"
    | "permission_preflight_failed";
  message: string;
  caseIds?: string[];
  issueIds?: string[];
  details?: Record<string, unknown>;
}

export interface PipelineAutomationRetryPlan {
  caseId: string;
  scope: PipelineAutomationRetryScope;
  allowed: boolean;
  caseVersion: number;
  currentStage: PipelineAutomationRetryStageRef;
  targetStage: PipelineAutomationRetryStageRef | null;
  availableTargetStages: PipelineAutomationRetryStageRef[];
  automationId: string | null;
  routine: PipelineAutomationRetryRoutineRef | null;
  previousAttemptId: string | null;
  generation: number;
  effectCounts: PipelineAutomationRetryEffectCounts;
  defaultCleanup: PipelineAutomationRetryCleanupOptions;
  blockers: PipelineAutomationRetryBlocker[];
}

export interface PipelineAutomationRetryRequest {
  scope: PipelineAutomationRetryScope;
  targetStageId?: string | null;
  expectedVersion: number;
  cleanup: PipelineAutomationRetryCleanupOptions;
}

export interface PipelineCaseDocumentPayload {
  link: {
    key: string;
    documentId: string;
    caseId: string;
    [key: string]: unknown;
  };
  document: {
    id: string;
    title: string | null;
    format: string;
    latestBody: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
    [key: string]: unknown;
  };
  revision?: {
    id: string;
    body?: string | null;
    title?: string | null;
    revisionNumber?: number;
    [key: string]: unknown;
  } | null;
}

export interface PipelineCaseDocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  caseId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: string;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date | string;
}

export type PipelineCaseOutputSourceRole = "origin" | "conversation" | "work" | "automation";
export type PipelineCaseOutputKind = "document" | "work_product" | "attachment";

export interface PipelineCaseOutputSource {
  linkId: string;
  role: PipelineCaseOutputSourceRole;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  issueStatus: string;
  sourceTrust?: SourceTrustMetadata | null;
  createdByRunId: string | null;
  linkedAt: Date | string;
}

export interface PipelineCaseOutputItemBase {
  id: string;
  kind: PipelineCaseOutputKind;
  title: string;
  sourceIssueId: string;
  sourceIssueIdentifier: string | null;
  sourceIssuePath: string;
  sourceIssueTitle: string;
  sourceIssueStatus: string;
  sourceRole: PipelineCaseOutputSourceRole;
  sourceTrust?: SourceTrustMetadata | null;
  sourceRunId: string | null;
  sourceAgentId: string | null;
  preview: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PipelineCaseDocumentOutputItem extends PipelineCaseOutputItemBase {
  kind: "document";
  documentId: string;
  documentKey: string;
  documentTitle: string | null;
  format: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  documentPath: string;
}

export interface PipelineCaseWorkProductOutputItem extends PipelineCaseOutputItemBase {
  kind: "work_product";
  workProductId: string;
  type: string;
  provider: string;
  externalId: string | null;
  url: string | null;
  status: string;
  reviewState: string;
  isPrimary: boolean;
  healthStatus: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PipelineCaseAttachmentOutputItem extends PipelineCaseOutputItemBase {
  kind: "attachment";
  attachmentId: string;
  assetId: string;
  filename: string | null;
  contentType: string;
  byteSize: number;
  contentPath: string;
  openPath: string;
  downloadPath: string;
}

export type PipelineCaseOutputItem =
  | PipelineCaseDocumentOutputItem
  | PipelineCaseWorkProductOutputItem
  | PipelineCaseAttachmentOutputItem;

export interface PipelineCaseOutputsResponse {
  caseId: string;
  pipelineId: string;
  generatedAt: Date | string;
  sources: PipelineCaseOutputSource[];
  items: PipelineCaseOutputItem[];
  counts: {
    documents: number;
    workProducts: number;
    attachments: number;
    bySourceRole: Partial<Record<PipelineCaseOutputSourceRole, number>>;
  };
}

export interface PipelineCaseOutputContextSummaryItem {
  id: string;
  kind: PipelineCaseOutputKind;
  title: string;
  key: string | null;
  revisionId: string | null;
  revisionNumber: number | null;
  sourceIssue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
    path: string;
    role: PipelineCaseOutputSourceRole;
  };
  sourceRunId: string | null;
  sourceAgentId: string | null;
  sourceTrust?: SourceTrustMetadata | null;
  excerpt: string | null;
  excerptTruncated: boolean;
  fetchHint: string;
}

export interface PipelineCaseOutputContextSummary {
  generatedAt: Date | string;
  itemCount: number;
  totalItemCount: number;
  omittedItemCount: number;
  excerptMaxChars: number;
  redactionNote: string;
  items: PipelineCaseOutputContextSummaryItem[];
}
