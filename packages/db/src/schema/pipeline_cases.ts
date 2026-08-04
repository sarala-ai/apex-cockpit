import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { documents } from "./documents.js";
import { issues } from "./issues.js";
import { pipelineStages, pipelines } from "./pipelines.js";
import { routines } from "./routines.js";

export type PipelineCasePendingSuggestion = {
  id: string;
  toStageKey: string;
  rationale: string;
  confidence?: number;
  suggestedByAgentId?: string;
  runId?: string;
  createdAt: string;
};

export type PipelineCaseWorkspaceRef = {
  executionWorkspaceId?: string;
  path?: string;
};

/** Which step kind an entry-automation row ran (0169). */
export const PIPELINE_AUTOMATION_EXECUTION_KINDS = ["routine", "run", "agent"] as const;
export type PipelineAutomationExecutionKind = (typeof PIPELINE_AUTOMATION_EXECUTION_KINDS)[number];

/** Which kind of process definition owns this case's steps.
 *
 *  One member since 0173, when the flow front-end was deleted. The
 *  discriminator is kept rather than dropped because it is what a second
 *  definition kind would reuse, and re-adding a dropped column later costs
 *  more than carrying a single-valued one. A case's steps are rows in
 *  `pipeline_stages`; the current one is addressed by `stepKey`. */
export const CASE_DEFINITION_KINDS = ["pipeline"] as const;
export type CaseDefinitionKind = (typeof CASE_DEFINITION_KINDS)[number];

/** What is in flight at a case's current step (0170). Deliberately NOT the
 *  retired flow front-end's six statuses: those conflated "where the case is"
 *  with "what is happening to it", and the case row already answers the
 *  first. */
export const PIPELINE_CASE_STEP_STATUSES = ["waiting_agent", "waiting_gate"] as const;
export type PipelineCaseStepStatus = (typeof PIPELINE_CASE_STEP_STATUSES)[number];

export const pipelineCases = pgTable(
  "pipeline_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // NOT NULL again since 0173. They were nullable only so a flow-defined
    // case — which had neither — could share this table while both front-ends
    // stood; that accommodation died with the flow front-end.
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id").notNull().references(() => pipelineStages.id),
    definitionKind: text("definition_kind").$type<CaseDefinitionKind>().notNull().default("pipeline"),
    /** The owning pipeline's id, as text. */
    definitionRef: text("definition_ref"),
    /** The AUTHORITATIVE current-step pointer (a stage key). `stageId` is the
     *  denormalised convenience that moves with it. */
    stepKey: text("step_key"),
    /** What is IN FLIGHT at the current step, or null when the case is simply
     *  sitting at it (0170). A `run` step finishes inside the call that starts
     *  it and never appears here; an `agent` step and a `gate` step do,
     *  because one waits on a run elsewhere and the other on a human. This is not a second location pointer — `stepKey` and
     *  `terminalKind` own where the case IS. */
    stepStatus: text("step_status").$type<PipelineCaseStepStatus | null>(),
    /** The bounded agent run this case is parked on (stepStatus =
     *  `waiting_agent`). The sweep and the run-completion hook both find the
     *  case through it. */
    stepRunId: uuid("step_run_id"),
    /** Who is executing the current agent step. Sticky across rework rounds:
     *  a step sent back by a reviewer is redone by whoever did it. */
    stepExecutorAgentId: uuid("step_executor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    caseKey: text("case_key").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    fields: jsonb("fields").$type<Record<string, unknown>>().notNull().default({}),
    workspaceRef: jsonb("workspace_ref").$type<PipelineCaseWorkspaceRef>(),
    parentCaseId: uuid("parent_case_id").references((): AnyPgColumn => pipelineCases.id, { onDelete: "set null" }),
    parentCaseVersion: integer("parent_case_version"),
    requestKey: text("request_key"),
    automationAttemptId: uuid("automation_attempt_id"),
    version: integer("version").notNull().default(1),
    pendingSuggestion: jsonb("pending_suggestion").$type<PipelineCasePendingSuggestion>(),
    leaseOwnerType: text("lease_owner_type"),
    leaseAgentId: uuid("lease_agent_id").references(() => agents.id, { onDelete: "set null" }),
    leaseUserId: text("lease_user_id"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    terminalKind: text("terminal_kind"),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredByAttemptId: uuid("retired_by_attempt_id"),
    retiredReason: text("retired_reason"),
    hiddenFromBoardAt: timestamp("hidden_from_board_at", { withTimezone: true }),
    childCount: integer("child_count").notNull().default(0),
    terminalChildCount: integer("terminal_child_count").notNull().default(0),
    createdByUserId: text("created_by_user_id"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    originRunId: uuid("origin_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pipelineCaseKeyUq: uniqueIndex("pipeline_cases_pipeline_case_key_uq").on(table.pipelineId, table.caseKey),
    parentRequestKeyUq: uniqueIndex("pipeline_cases_parent_request_key_uq")
      .on(table.parentCaseId, table.requestKey)
      .where(sql`${table.requestKey} is not null and ${table.retiredAt} is null`),
    companyIdx: index("pipeline_cases_company_idx").on(table.companyId),
    pipelineStageIdx: index("pipeline_cases_pipeline_stage_idx").on(table.pipelineId, table.stageId),
    parentIdx: index("pipeline_cases_parent_idx").on(table.parentCaseId),
    automationAttemptIdx: index("pipeline_cases_automation_attempt_idx").on(table.automationAttemptId),
    retiredIdx: index("pipeline_cases_retired_idx").on(table.companyId, table.retiredAt),
    leaseExpiresIdx: index("pipeline_cases_lease_expires_idx").on(table.leaseExpiresAt).where(sql`${table.leaseExpiresAt} is not null`),
    stepStatusIdx: index("pipeline_cases_step_status_idx")
      .on(table.companyId, table.stepStatus, table.updatedAt)
      .where(sql`${table.stepStatus} is not null`),
    stepRunIdx: index("pipeline_cases_step_run_idx")
      .on(table.stepRunId)
      .where(sql`${table.stepRunId} is not null`),
    stepStatusCheck: check(
      "pipeline_cases_step_status_check",
      sql`${table.stepStatus} is null or ${table.stepStatus} in ('waiting_agent', 'waiting_gate')`,
    ),
    definitionIdx: index("pipeline_cases_definition_idx").on(table.companyId, table.definitionKind, table.definitionRef),
    terminalKindCheck: check("pipeline_cases_terminal_kind_check", sql`${table.terminalKind} is null or ${table.terminalKind} in ('done', 'cancelled')`),
    definitionKindCheck: check(
      "pipeline_cases_definition_kind_check",
      sql`${table.definitionKind} = 'pipeline'`,
    ),
    leaseOwnerTypeCheck: check("pipeline_cases_lease_owner_type_check", sql`${table.leaseOwnerType} is null or ${table.leaseOwnerType} in ('user', 'agent')`),
  }),
);

export const pipelineCaseIssueLinks = pgTable(
  "pipeline_case_issue_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdByRunId: uuid("created_by_run_id"),
    automationAttemptId: uuid("automation_attempt_id"),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    retiredByAttemptId: uuid("retired_by_attempt_id"),
    retiredReason: text("retired_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseIssueUq: uniqueIndex("pipeline_case_issue_links_case_issue_uq").on(table.caseId, table.issueId),
    issueIdx: index("pipeline_case_issue_links_issue_idx").on(table.issueId),
    companyCaseIdx: index("pipeline_case_issue_links_company_case_idx").on(table.companyId, table.caseId),
    automationAttemptIdx: index("pipeline_case_issue_links_automation_attempt_idx").on(table.automationAttemptId),
    roleCheck: check("pipeline_case_issue_links_role_check", sql`${table.role} in ('origin', 'conversation', 'work', 'automation')`),
  }),
);

export const pipelineCaseBlockers = pgTable(
  "pipeline_case_blockers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    blockedByCaseId: uuid("blocked_by_case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseBlockedByUq: uniqueIndex("pipeline_case_blockers_case_blocked_by_uq").on(table.caseId, table.blockedByCaseId),
    blockedByIdx: index("pipeline_case_blockers_blocked_by_idx").on(table.blockedByCaseId),
    companyCaseIdx: index("pipeline_case_blockers_company_case_idx").on(table.companyId, table.caseId),
    noSelfBlockCheck: check("pipeline_case_blockers_no_self_block_check", sql`${table.caseId} <> ${table.blockedByCaseId}`),
  }),
);

export const pipelineDocuments = pgTable(
  "pipeline_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPipelineKeyUq: uniqueIndex("pipeline_documents_company_pipeline_key_uq").on(
      table.companyId,
      table.pipelineId,
      table.key,
    ),
    documentUq: uniqueIndex("pipeline_documents_document_uq").on(table.documentId),
    companyPipelineUpdatedIdx: index("pipeline_documents_company_pipeline_updated_idx").on(
      table.companyId,
      table.pipelineId,
      table.updatedAt,
    ),
  }),
);

export const pipelineCaseDocuments = pgTable(
  "pipeline_case_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCaseKeyUq: uniqueIndex("pipeline_case_documents_company_case_key_uq").on(
      table.companyId,
      table.caseId,
      table.key,
    ),
    documentUq: uniqueIndex("pipeline_case_documents_document_uq").on(table.documentId),
    companyCaseUpdatedIdx: index("pipeline_case_documents_company_case_updated_idx").on(
      table.companyId,
      table.caseId,
      table.updatedAt,
    ),
  }),
);

export const pipelineAutomationExecutions = pgTable(
  "pipeline_automation_executions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    caseId: uuid("case_id").notNull().references(() => pipelineCases.id, { onDelete: "cascade" }),
    automationId: text("automation_id").notNull(),
    triggeringEventId: uuid("triggering_event_id").notNull(),
    /** Which step kind this entry ran (0169). `run` is deterministic and costs
     *  nothing; `agent` costs tokens; `routine` predates both. */
    kind: text("kind").$type<PipelineAutomationExecutionKind>().notNull().default("routine"),
    /** Nullable since 0169: a run entry carries no routine. The shape
     *  check below makes a half-populated row impossible either way. */
    routineId: uuid("routine_id").references(() => routines.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    executionIssueId: uuid("execution_issue_id").references(() => issues.id, { onDelete: "set null" }),
    retryOfExecutionId: uuid("retry_of_execution_id"),
    generation: integer("generation").notNull().default(1),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUq: uniqueIndex("pipeline_automation_executions_idempotency_uq").on(
      table.caseId,
      table.automationId,
      table.triggeringEventId,
    ),
    companyCaseIdx: index("pipeline_automation_executions_company_case_idx").on(table.companyId, table.caseId),
    routineIdx: index("pipeline_automation_executions_routine_idx").on(table.routineId),
    executionIssueIdx: index("pipeline_automation_executions_execution_issue_idx").on(table.executionIssueId),
    retryOfExecutionIdx: index("pipeline_automation_executions_retry_of_execution_idx").on(table.retryOfExecutionId),
    statusCheck: check("pipeline_automation_executions_status_check", sql`${table.status} in ('succeeded', 'failed')`),
    kindCheck: check(
      "pipeline_automation_executions_kind_check",
      sql`${table.kind} in ('routine', 'run', 'agent')`,
    ),
    shapeCheck: check(
      "pipeline_automation_executions_shape_check",
      sql`(${table.kind} = 'routine' and ${table.routineId} is not null)
        or (${table.kind} in ('run', 'agent') and ${table.routineId} is null)`,
    ),
  }),
);
