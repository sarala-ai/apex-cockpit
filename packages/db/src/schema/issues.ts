import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { projectWorkspaces } from "./project_workspaces.js";
import { executionWorkspaces } from "./execution_workspaces.js";
import type { SourceTrustMetadata } from "@paperclipai/shared";

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    projectId: uuid("project_id").references(() => projects.id),
    projectWorkspaceId: uuid("project_workspace_id").references(() => projectWorkspaces.id, { onDelete: "set null" }),
    goalId: uuid("goal_id").references(() => goals.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => issues.id),
    title: text("title").notNull(),
    description: text("description"),
    // The machine-facing half of a ticket: ids, coordinates, payload shapes,
    // exact CLI invocations — everything an agent needs and no human reading
    // the ticket wants in their way. `description` stays the human body (the
    // outcome wanted and the decision); this column carries the brief.
    // Additive/nullable: existing tickets keep their body as their body.
    agentBrief: text("agent_brief"),
    status: text("status").notNull().default("backlog"),
    workMode: text("work_mode").notNull().default("standard"),
    harnessKind: text("harness_kind"),
    priority: text("priority").notNull().default("medium"),
    assigneeAgentId: uuid("assignee_agent_id").references(() => agents.id),
    assigneeUserId: text("assignee_user_id"),
    checkoutRunId: uuid("checkout_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionRunId: uuid("execution_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    executionAgentNameKey: text("execution_agent_name_key"),
    executionLockedAt: timestamp("execution_locked_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id),
    createdByUserId: text("created_by_user_id"),
    responsibleUserId: text("responsible_user_id"),
    issueNumber: integer("issue_number"),
    identifier: text("identifier"),
    originKind: text("origin_kind").notNull().default("manual"),
    originId: text("origin_id"),
    originRunId: text("origin_run_id"),
    originFingerprint: text("origin_fingerprint").notNull().default("default"),
    requestDepth: integer("request_depth").notNull().default(0),
    billingCode: text("billing_code"),
    assigneeAdapterOverrides: jsonb("assignee_adapter_overrides").$type<Record<string, unknown>>(),
    executionPolicy: jsonb("execution_policy").$type<Record<string, unknown>>(),
    executionState: jsonb("execution_state").$type<Record<string, unknown>>(),
    monitorNextCheckAt: timestamp("monitor_next_check_at", { withTimezone: true }),
    monitorWakeRequestedAt: timestamp("monitor_wake_requested_at", { withTimezone: true }),
    monitorLastTriggeredAt: timestamp("monitor_last_triggered_at", { withTimezone: true }),
    monitorAttemptCount: integer("monitor_attempt_count").notNull().default(0),
    monitorNotes: text("monitor_notes"),
    monitorScheduledBy: text("monitor_scheduled_by"),
    executionWorkspaceId: uuid("execution_workspace_id")
      .references((): AnyPgColumn => executionWorkspaces.id, { onDelete: "set null" }),
    executionWorkspacePreference: text("execution_workspace_preference"),
    executionWorkspaceSettings: jsonb("execution_workspace_settings").$type<Record<string, unknown>>(),
    sourceTrust: jsonb("source_trust").$type<SourceTrustMetadata | null>(),
    // ---------------------------------------------------------------------
    // DERIVED FROM THE CASE — a denormalised mirror, not the source of truth.
    //
    // Since 0165 the authoritative runtime state of a flow-driven issue lives
    // on its case row in `pipeline_cases` (definition_kind='flow'), linked here
    // through `pipeline_case_issue_links` with role 'work': the case holds the
    // current step (`step_key`), the optimistic-concurrency `version` and the
    // terminal (`terminal_kind`/`terminal_at`). The flow coordinator writes the
    // case FIRST, under a version compare-and-set, and only then mirrors into
    // the columns below in the same transaction.
    //
    // They stay because many surfaces still read them directly — issue lists,
    // IssueDetail, the observe plane, heartbeat's flow-context lookups. They
    // are REMOVED by the step that retires the flow front-end
    // (docs/architecture/execution-substrate.md §6 step 5); until then, treat
    // every column below as read-only outside server/src/apex/flow/coordinator.ts.
    // ---------------------------------------------------------------------
    flowName: text("flow_name"),
    flowNodeId: text("flow_node_id"),
    // 'running' | 'waiting_gate' | 'waiting_agent' | 'paused' | 'done' | 'failed'
    flowStatus: text("flow_status"),
    // Heartbeat run commissioned for the current agent node (A-node bridge):
    // set while flowStatus='waiting_agent', the completion hook + sweep match
    // run completions against it. Nullable — a wakeup can be deferred.
    flowRunId: uuid("flow_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    flowStartedAt: timestamp("flow_started_at", { withTimezone: true }),
    flowAdvancedAt: timestamp("flow_advanced_at", { withTimezone: true }),
    // The agent the flow commissions its agent nodes to, resolved ONCE when
    // the flow's first agent node runs and owned by the coordinator until the
    // flow reaches a terminal state.
    //
    // Why this is not `assigneeAgentId`: that column has another owner. The
    // per-issue execution policy (services/issue-execution-policy.ts) rewrites
    // it to the REVIEWER when it intercepts a done-transition, deliberately
    // excluding the executor so that review is independent. The flow
    // coordinator used to read `assigneeAgentId` as "who executes this flow",
    // so on any issue carrying both mechanisms the flow's next agent step was
    // commissioned to the reviewer — silently defeating the very independence
    // the execution policy exists to enforce
    // (server/src/__tests__/flow-execution-policy-interaction.test.ts pins it).
    // Two single-writer claims on one column is the bug; a column the
    // coordinator alone writes is the fix.
    flowExecutorAgentId: uuid("flow_executor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    // GitHub projection mirror ref ("owner/repo#123") — set once when the
    // projection CREATES a mirror issue for a board-origin ticket (typed column
    // by doctrine, never jsonb). NULL for github-origin issues: their own
    // origin issue (originKind='plugin:github', originId) is the mirror target
    // and is never duplicated or closed by the projection.
    githubMirrorRef: text("github_mirror_ref"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyStatusIdx: index("issues_company_status_idx").on(table.companyId, table.status),
    companyHarnessKindIdx: index("issues_company_harness_kind_idx").on(table.companyId, table.harnessKind),
    assigneeStatusIdx: index("issues_company_assignee_status_idx").on(
      table.companyId,
      table.assigneeAgentId,
      table.status,
    ),
    assigneeUserStatusIdx: index("issues_company_assignee_user_status_idx").on(
      table.companyId,
      table.assigneeUserId,
      table.status,
    ),
    responsibleUserIdx: index("issues_company_responsible_user_idx").on(table.companyId, table.responsibleUserId),
    parentIdx: index("issues_company_parent_idx").on(table.companyId, table.parentId),
    projectIdx: index("issues_company_project_idx").on(table.companyId, table.projectId),
    originIdx: index("issues_company_origin_idx").on(table.companyId, table.originKind, table.originId),
    projectWorkspaceIdx: index("issues_company_project_workspace_idx").on(table.companyId, table.projectWorkspaceId),
    executionWorkspaceIdx: index("issues_company_execution_workspace_idx").on(table.companyId, table.executionWorkspaceId),
    dueMonitorIdx: index("issues_company_monitor_due_idx").on(table.companyId, table.monitorNextCheckAt),
    flowStatusIdx: index("issues_company_flow_status_idx").on(table.companyId, table.flowStatus),
    companyUpdatedIdx: index("issues_company_updated_idx").on(table.companyId, table.updatedAt),
    companyCreatedIdx: index("issues_company_created_idx").on(table.companyId, table.createdAt),
    companyPriorityIdx: index("issues_company_priority_idx").on(table.companyId, table.priority),
    identifierIdx: uniqueIndex("issues_identifier_idx").on(table.identifier),
    titleSearchIdx: index("issues_title_search_idx").using("gin", table.title.op("gin_trgm_ops")),
    identifierSearchIdx: index("issues_identifier_search_idx").using("gin", table.identifier.op("gin_trgm_ops")),
    descriptionSearchIdx: index("issues_description_search_idx").using("gin", table.description.op("gin_trgm_ops")),
    openRoutineExecutionIdx: uniqueIndex("issues_open_routine_execution_uq")
      .on(table.companyId, table.originKind, table.originId, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'routine_execution'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.executionRunId} is not null
          and ${table.status} in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')`,
      ),
    activeLivenessRecoveryIncidentIdx: uniqueIndex("issues_active_liveness_recovery_incident_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeLivenessRecoveryLeafIdx: uniqueIndex("issues_active_liveness_recovery_leaf_uq")
      .on(table.companyId, table.originKind, table.originFingerprint)
      .where(
        sql`${table.originKind} = 'harness_liveness_escalation'
          and ${table.originFingerprint} <> 'default'
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStaleRunEvaluationIdx: uniqueIndex("issues_active_stale_run_evaluation_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stale_active_run_evaluation'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeTaskWatchdogIdx: uniqueIndex("issues_active_task_watchdog_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'task_watchdog'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeProductivityReviewIdx: uniqueIndex("issues_active_productivity_review_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'issue_productivity_review'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    activeStrandedIssueRecoveryIdx: uniqueIndex("issues_active_stranded_issue_recovery_uq")
      .on(table.companyId, table.originKind, table.originId)
      .where(
        sql`${table.originKind} = 'stranded_issue_recovery'
          and ${table.originId} is not null
          and ${table.hiddenAt} is null
          and ${table.status} not in ('done', 'cancelled')`,
      ),
    // Finding 5b (adversarial architecture review): the GitHub ingest job
    // upserts by (companyId, originFingerprint) at the application layer, but
    // nothing stopped the scheduler tick and a manual `POST
    // /apex/github-ingest` from racing each other into two inserts for the
    // same GitHub issue. This constraint makes the dedupe atomic — scoped to
    // `plugin:github` origin only, mirroring the other origin-scoped partial
    // unique indexes above.
    githubOriginFingerprintIdx: uniqueIndex("issues_github_origin_fingerprint_uq")
      .on(table.companyId, table.originFingerprint)
      .where(sql`${table.originKind} = 'plugin:github'`),
  }),
);
