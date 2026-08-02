/**
 * COMPANY DATA ERASURE — the manifest, the preview, and the one transaction.
 *
 * Everything destructive about this file is constrained by three decisions:
 *
 * 1. **The table list is written down, not inferred from cascade.** Postgres
 *    cascade rules were written one migration at a time to answer "what happens
 *    when this parent goes", never to answer "what is a company's data". They
 *    disagree with that question in both directions: `company_logos` cascades
 *    from an asset an erasure would otherwise take, and `company_skill_stars`
 *    cascades from an agent. So every company-scoped table is classified HERE,
 *    by hand, as erased or preserved — and a test fails when a new one appears
 *    in neither list. Trusting cascade is how a reset silently starts missing a
 *    table nobody remembers adding.
 *
 * 2. **Delete order is computed, not maintained.** The order is a topological
 *    sort of the real foreign-key graph read out of the Drizzle schema,
 *    child-before-parent over the edges that actually block (`no action`,
 *    `restrict`). A hand-maintained order is correct on the day it is written
 *    and wrong after the next migration, and it fails in production rather than
 *    in review.
 *
 * 3. **The preview and the execution are the same code path.** `dryRun` gates
 *    the writes, never the counting — so the numbers a person approves are the
 *    numbers the transaction produces, and they cannot drift apart.
 */
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import * as schema from "@paperclipai/db";
import {
  activityLog,
  agentApiKeys,
  agentConfigRevisions,
  agentMemberships,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvalComments,
  approvals,
  assets,
  budgetIncidents,
  builtInManagedResources,
  caseAttachments,
  caseDocuments,
  caseEvents,
  caseIssueLinks,
  caseLabels,
  cases,
  cloudUpstreamRuns,
  companies,
  companyLogos,
  companySkillTestRuns,
  costEvents,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentRevisions,
  documents,
  environmentLeases,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  feedbackExports,
  feedbackVotes,
  financeEvents,
  goals,
  heartbeatRunEvents,
  heartbeatRunWatchdogDecisions,
  heartbeatRuns,
  inboxDismissals,
  issueApprovals,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueInboxArchives,
  issueLabels,
  issuePlanDecompositions,
  issueReadStates,
  issueRecoveryActions,
  issueReferenceMentions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issueWatchdogs,
  issueWorkProducts,
  issues,
  joinRequests,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseDocuments,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineDocuments,
  pluginEntities,
  pluginJobRuns,
  pluginLogs,
  pluginManagedResources,
  pluginWebhookDeliveries,
  projectGoals,
  projectMemberships,
  projectWorkspaces,
  projects,
  proposals,
  releaseArtifacts,
  releaseChanges,
  releases,
  resourceAttributions,
  routineDocuments,
  routineRevisions,
  routineRuns,
  routineTriggers,
  routines,
  secretAccessEvents,
  workspaceOperations,
  workspaceRuntimeServices,
  // Preserved — imported so each classification is a reference to the real
  // table, not a string that can quietly stop matching the schema.
  budgetPolicies,
  cloudUpstreamConnections,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecrets,
  companySkillComments,
  companySkillStars,
  companySkillTestInputs,
  companySkillTestRunTemplates,
  companySkillVersions,
  companySkills,
  companyUserSidebarPreferences,
  invites,
  labels,
  pipelines,
  pluginCompanySettings,
  principalPermissionGrants,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import {
  DATA_ERASURE_ACTIVITY_ACTION,
  DATA_ERASURE_DEFAULT_CHILD_MODE,
  type CompanyDataErasureReport,
  type DataErasureChildMode,
  type DataErasureDetachCount,
  type DataErasureScope,
  type DataErasureTableCount,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";

/**
 * THE ONE PLACE the launch exposure decision lives.
 *
 * The call today is "needed for testing, decided later for final launch", so
 * this deliberately returns true in every deployment — what makes the route
 * safe to point at a real board is the envelope around it (owner gate, dry run
 * by default, slug confirmation, audit record), not the route's absence. When
 * launch exposure IS decided, change this function and nothing else: no caller
 * of the erasure service and no other layer knows a deployment mode.
 */
export function isCompanyDataErasureExposed(): boolean {
  return true;
}

type ErasableTable = { table: PgTable; name: string };

function named(table: PgTable): ErasableTable {
  return { table, name: getTableConfig(table).name };
}

/**
 * Every company-scoped table whose rows ARE the company's data. Order here is
 * meaningless — it is sorted topologically before use. Grouped by what a reader
 * would call them, because "is that on the list?" is the question this file
 * gets asked.
 */
const ERASED_TABLES: ErasableTable[] = [
  // The workforce and everything it carries. An agent is company data, not
  // company configuration: the immediate case for this endpoint is 156 objects
  // attributed to an agent that never ran.
  named(agents),
  named(agentApiKeys),
  named(agentConfigRevisions),
  named(agentMemberships),
  named(agentRuntimeState),
  named(agentTaskSessions),
  named(agentWakeupRequests),
  named(joinRequests),

  // Runs and their traces.
  named(heartbeatRuns),
  named(heartbeatRunEvents),
  named(heartbeatRunWatchdogDecisions),

  // The board proper.
  named(issues),
  named(issueApprovals),
  named(issueAttachments),
  named(issueComments),
  named(issueDocuments),
  named(issueExecutionDecisions),
  named(issueInboxArchives),
  named(issueLabels),
  named(issuePlanDecompositions),
  named(issueReadStates),
  named(issueRecoveryActions),
  named(issueReferenceMentions),
  named(issueRelations),
  named(issueThreadInteractions),
  named(issueTreeHolds),
  named(issueTreeHoldMembers),
  named(issueWatchdogs),
  named(issueWorkProducts),
  named(goals),
  named(projects),
  named(projectGoals),
  named(projectMemberships),
  named(projectWorkspaces),
  named(proposals),

  // Cases and the pipeline instances that run them. NOTE the asymmetry with
  // `pipelines` in the preserved list: a pipeline DEFINITION is configuration a
  // person authored and survives; the cases flowing through it are work and do
  // not.
  named(cases),
  named(caseAttachments),
  named(caseDocuments),
  named(caseEvents),
  named(caseIssueLinks),
  named(caseLabels),
  named(pipelineCases),
  named(pipelineCaseBlockers),
  named(pipelineCaseDocuments),
  named(pipelineCaseEvents),
  named(pipelineCaseIssueLinks),
  named(pipelineAutomationExecutions),
  // A link row to a document that is about to be deleted; it cannot outlive it.
  named(pipelineDocuments),

  // Documents and everything written on them.
  named(documents),
  named(documentRevisions),
  named(documentAnnotationThreads),
  named(documentAnnotationComments),
  named(documentAnnotationAnchorSnapshots),

  // Approvals and money. Cost and finance events are deleted at COMPANY scope
  // (the tenant's data is leaving) but only DETACHED at project/initiative
  // scope — spend that happened is a fact about the company, and erasing the
  // object it was attributed to does not unspend it.
  named(approvals),
  named(approvalComments),
  named(costEvents),
  named(financeEvents),
  named(budgetIncidents),

  // Automation. Routines cascade off projects in the schema already, so leaving
  // them out would not preserve them — it would delete them silently.
  named(routines),
  named(routineDocuments),
  named(routineRevisions),
  named(routineRuns),
  named(routineTriggers),

  // Execution surfaces and their runtime state.
  named(executionWorkspaces),
  named(workspaceOperations),
  named(workspaceRuntimeServices),
  named(environmentLeases),

  // Releases.
  named(releases),
  named(releaseArtifacts),
  named(releaseChanges),

  // Externally mirrored objects and derived attributions.
  named(externalObjects),
  named(externalObjectMentions),
  named(resourceAttributions),

  // Per-user board state about issues that are about to stop existing.
  named(inboxDismissals),

  // Feedback.
  named(feedbackVotes),
  named(feedbackExports),

  // Plugin-owned rows. The plugin INSTALLATION and its settings survive
  // (`plugin_company_settings`); the records it created do not.
  named(pluginEntities),
  named(pluginJobRuns),
  named(pluginLogs),
  named(pluginManagedResources),
  named(pluginWebhookDeliveries),

  // Run history against preserved configuration.
  named(cloudUpstreamRuns),
  named(secretAccessEvents),
  // Skill TEST RUNS are work; the skills themselves are not. This one is also
  // forced: the row hard-references agents and issues ON DELETE RESTRICT, so
  // preserving it would make erasing the workforce impossible.
  named(companySkillTestRuns),
  named(builtInManagedResources),

  // Assets — special-cased at execution: everything except the asset backing
  // the company logo, which is branding and is preserved with it.
  named(assets),

  // The company's own audit trail. It has to go (it hard-references agents and
  // runs), and the erasure's audit record is written after it inside the same
  // transaction, so a reset is never the one event that left no trace.
  named(activityLog),
];

/**
 * Company-scoped tables deliberately LEFT ALONE. This is not "everything else"
 * — it is a decision per table, and the shape of the decision is: **who the
 * company IS and how it is configured survives; what the company DID does not.**
 * A reset must leave an operator able to log in, keep their integrations
 * working, and start over — not hand them an empty shell to reconfigure.
 */
const PRESERVED_TABLES: ErasableTable[] = [
  // Identity and access.
  named(companyMemberships),
  named(principalPermissionGrants),
  named(invites),
  named(companyUserSidebarPreferences),
  // Branding.
  named(companyLogos),
  // Credentials. Erasing these would break every configured integration, which
  // is not what "clean the board" means to anyone who asks for it.
  named(companySecrets),
  named(companySecretBindings),
  named(companySecretProviderConfigs),
  named(userSecretDefinitions),
  named(userSecretDeclarations),
  // Policy and configuration.
  named(budgetPolicies),
  named(cloudUpstreamConnections),
  named(labels),
  named(pluginCompanySettings),
  // Pipeline DEFINITIONS. Stages and transitions hang off these and are not
  // company-scoped, so they follow automatically.
  named(pipelines),
  // The authored skill library. Its test RUNS are erased above; the skills,
  // versions, stars, comments and test inputs are authored content.
  named(companySkills),
  named(companySkillVersions),
  named(companySkillComments),
  named(companySkillStars),
  named(companySkillTestInputs),
  named(companySkillTestRunTemplates),
];

/** Every table in the Drizzle schema carrying a `company_id` column. */
export function companyScopedTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const config = getTableConfig(value as never);
    if (config.columns.some((column) => column.name === "company_id")) {
      names.push(config.name);
    }
  }
  return names.sort();
}

export function erasedTableNames(): string[] {
  return ERASED_TABLES.map((entry) => entry.name).sort();
}

export function preservedTableNames(): string[] {
  return PRESERVED_TABLES.map((entry) => entry.name).sort();
}

/**
 * Child-before-parent order over the foreign-key edges that actually block a
 * delete. `cascade` and `set null` edges are ignored: Postgres resolves those
 * itself, and treating them as ordering constraints would invent cycles that do
 * not exist. Self-references are ignored too — a whole-table delete satisfies
 * them in one statement.
 *
 * Returns `{ order, cycle }`; a non-empty `cycle` means the schema grew a loop
 * of blocking FKs, which a test asserts has not happened.
 */
export function topologicalDeleteOrder(tables: ErasableTable[]): {
  order: ErasableTable[];
  cycle: string[];
} {
  const inScope = new Map(tables.map((entry) => [entry.name, entry]));
  const parents = new Map<string, Set<string>>();
  for (const entry of tables) parents.set(entry.name, new Set());

  for (const entry of tables) {
    const config = getTableConfig(entry.table);
    for (const fk of config.foreignKeys) {
      const action = fk.onDelete ?? "no action";
      if (action !== "no action" && action !== "restrict") continue;
      const target = getTableConfig(fk.reference().foreignTable as never).name;
      if (target === entry.name) continue;
      if (!inScope.has(target)) continue;
      parents.get(entry.name)!.add(target);
    }
  }

  // Kahn's algorithm, "child first": a table is emittable once nothing it still
  // points at is waiting behind it.
  const remaining = new Set(parents.keys());
  const order: ErasableTable[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((name) => [...parents.get(name)!].every((parent) => !remaining.has(parent)))
      .sort();
    if (ready.length === 0) {
      const cycle = [...remaining].sort();
      for (const name of cycle) order.push(inScope.get(name)!);
      return { order, cycle };
    }
    for (const name of ready) {
      order.push(inScope.get(name)!);
      remaining.delete(name);
    }
  }
  return { order, cycle: [] };
}

/** Memoised: the schema does not change at runtime. */
let cachedOrder: ErasableTable[] | null = null;
function erasureOrder(): ErasableTable[] {
  cachedOrder ??= topologicalDeleteOrder(ERASED_TABLES).order;
  return cachedOrder;
}

export function erasedTablesForTest(): ErasableTable[] {
  return ERASED_TABLES;
}

export function companyErasureDeleteOrder(): string[] {
  return erasureOrder().map((entry) => entry.name);
}

function companyIdColumn(table: PgTable) {
  return (table as unknown as { companyId: never }).companyId;
}

/**
 * The company-scoped predicate for a whole-table erase, plus the one exception.
 * EVERY delete this service issues carries this — a tampered `:companyId` can
 * only ever reach rows that belong to the company it names.
 */
function scopeCondition(entry: ErasableTable, companyId: string) {
  const base = eq(companyIdColumn(entry.table), companyId as never);
  if (entry.name !== "assets") return base;
  // `company_logos` is preserved but cascades from `assets`, so preserving the
  // logo means excluding the asset it points at. The subquery is scoped to this
  // company too, so it can neither read nor spare another company's row.
  return and(
    base,
    sql`${assets.id} not in (select ${companyLogos.assetId} from ${companyLogos} where ${companyLogos.companyId} = ${companyId})`,
  );
}

async function countTable(tx: Db, entry: ErasableTable, companyId: string): Promise<number> {
  const rows = await tx
    .select({ value: sql<number>`count(*)::int` })
    .from(entry.table as never)
    .where(scopeCondition(entry, companyId) as never);
  return (rows[0] as { value: number } | undefined)?.value ?? 0;
}

function sortCounts(counts: DataErasureTableCount[]): DataErasureTableCount[] {
  return counts
    .filter((entry) => entry.rows > 0)
    .sort((a, b) => b.rows - a.rows || a.table.localeCompare(b.table));
}

function addDelete(list: DataErasureTableCount[], table: string, rows: number) {
  if (rows > 0) list.push({ table, rows });
}

function addDetach(list: DataErasureDetachCount[], table: string, column: string, rows: number) {
  if (rows > 0) list.push({ table, column, rows });
}

/** Thrown to roll a preview (or a blocked erasure) back explicitly. */
class ErasureRollback extends Error {
  constructor(readonly report: CompanyDataErasureReport) {
    super("erasure rolled back");
  }
}

export type ErasureActor = {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

export type CompanyDataErasureInput = {
  scope: DataErasureScope;
  children?: DataErasureChildMode;
  confirm?: string;
};

export function companyDataErasureService(db: Db) {
  async function count(tx: Db, table: PgTable, where: unknown): Promise<number> {
    const rows = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(table as never)
      .where(where as never);
    return (rows[0] as { value: number } | undefined)?.value ?? 0;
  }

  /**
   * Resolve the target and enforce the confirmation. Both live here so no
   * caller can execute without having passed them: unknown company → 404,
   * wrong slug → 422, no slug at all → dry run.
   */
  async function resolveTarget(companyId: string, confirm: string | undefined) {
    const company = await db
      .select({ id: companies.id, slug: companies.slug, name: companies.name })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company) throw notFound("Company not found");

    if (confirm === undefined) return { company, dryRun: true as const };

    const expected = (company.slug ?? "").trim();
    const supplied = confirm.trim();
    // Matched against the company being erased, never against anything else the
    // caller supplied. A confirmation satisfiable without knowing the target is
    // not a confirmation.
    if (!expected || supplied.toLowerCase() !== expected.toLowerCase()) {
      throw unprocessable("Confirmation does not match this company's slug — nothing was erased.", {
        code: "erasure_confirmation_mismatch",
      });
    }
    return { company, dryRun: false as const };
  }

  /** The initiatives of a company, plus every goal beneath them. */
  async function initiativeGoalIds(tx: Db, companyId: string): Promise<string[]> {
    // A sub-goal cannot outlive its initiative: `goals.parent_id` is ON DELETE
    // NO ACTION, so leaving descendants behind would not preserve them — it
    // would make the delete fail.
    const rows = await tx.execute(sql`
      with recursive tree as (
        select id from goals
          where company_id = ${companyId} and level = 'initiative'
        union
        select child.id from goals child
          join tree on child.parent_id = tree.id
          where child.company_id = ${companyId}
      )
      select id from tree
    `);
    const list = Array.isArray(rows) ? rows : [];
    return (list as Array<{ id: string }>).map((row) => row.id);
  }

  async function projectsAttachedToGoals(tx: Db, companyId: string, goalIds: string[]) {
    if (goalIds.length === 0) return [] as string[];
    const [direct, linked] = await Promise.all([
      tx
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.companyId, companyId),
            or(inArray(projects.goalId, goalIds), inArray(projects.foldedIntoGoalId, goalIds)),
          ),
        ),
      tx
        .select({ id: projectGoals.projectId })
        .from(projectGoals)
        .where(and(eq(projectGoals.companyId, companyId), inArray(projectGoals.goalId, goalIds))),
    ]);
    return [...new Set([...direct.map((r) => r.id), ...linked.map((r) => r.id)])];
  }

  async function issuesReferencingGoals(tx: Db, companyId: string, goalIds: string[]) {
    if (goalIds.length === 0) return [] as string[];
    const rows = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.goalId, goalIds)));
    return rows.map((row) => row.id);
  }

  async function allProjectIds(tx: Db, companyId: string) {
    const rows = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.companyId, companyId));
    return rows.map((row) => row.id);
  }

  async function issuesInProjects(tx: Db, companyId: string, projectIds: string[]) {
    if (projectIds.length === 0) return [] as string[];
    const rows = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.projectId, projectIds)));
    return rows.map((row) => row.id);
  }

  /**
   * Delete a set of issues and the four rows types that block them. Every other
   * `issue_*` table cascades from `issues` already; these do not (`no action` /
   * `restrict`) and would fail the transaction.
   */
  async function deleteIssues(
    tx: Db,
    companyId: string,
    issueIds: string[],
    deletes: DataErasureTableCount[],
    detaches: DataErasureDetachCount[],
    dryRun: boolean,
  ) {
    if (issueIds.length === 0) return;
    const inSet = inArray(issues.id, issueIds);

    const [votes, testRuns, cost, finance, orphanChildren] = await Promise.all([
      count(tx, feedbackVotes, and(eq(feedbackVotes.companyId, companyId), inArray(feedbackVotes.issueId, issueIds))),
      count(tx, companySkillTestRuns, and(eq(companySkillTestRuns.companyId, companyId), inArray(companySkillTestRuns.issueId, issueIds))),
      count(tx, costEvents, and(eq(costEvents.companyId, companyId), inArray(costEvents.issueId, issueIds))),
      count(tx, financeEvents, and(eq(financeEvents.companyId, companyId), inArray(financeEvents.issueId, issueIds))),
      count(tx, issues, and(eq(issues.companyId, companyId), inArray(issues.parentId, issueIds), notInArray(issues.id, issueIds))),
    ]);

    addDelete(deletes, "feedback_votes", votes);
    addDelete(deletes, "company_skill_test_runs", testRuns);
    addDetach(detaches, "cost_events", "issue_id", cost);
    addDetach(detaches, "finance_events", "issue_id", finance);
    addDetach(detaches, "issues", "parent_id", orphanChildren);
    addDelete(deletes, "issues", issueIds.length);

    if (dryRun) return;

    await tx.delete(feedbackVotes).where(and(eq(feedbackVotes.companyId, companyId), inArray(feedbackVotes.issueId, issueIds)));
    await tx.delete(companySkillTestRuns).where(and(eq(companySkillTestRuns.companyId, companyId), inArray(companySkillTestRuns.issueId, issueIds)));
    await tx.update(costEvents).set({ issueId: null }).where(and(eq(costEvents.companyId, companyId), inArray(costEvents.issueId, issueIds)));
    await tx.update(financeEvents).set({ issueId: null }).where(and(eq(financeEvents.companyId, companyId), inArray(financeEvents.issueId, issueIds)));
    await tx.update(issues).set({ parentId: null }).where(and(eq(issues.companyId, companyId), inArray(issues.parentId, issueIds), notInArray(issues.id, issueIds)));
    await tx.delete(issues).where(and(eq(issues.companyId, companyId), inSet));
  }

  /**
   * Delete a set of projects and the rows that block them. `issues` is NOT
   * handled here — the caller decides that per child mode.
   */
  async function deleteProjects(
    tx: Db,
    companyId: string,
    projectIds: string[],
    deletes: DataErasureTableCount[],
    detaches: DataErasureDetachCount[],
    dryRun: boolean,
  ) {
    if (projectIds.length === 0) return;

    const [cost, finance, folded] = await Promise.all([
      count(tx, costEvents, and(eq(costEvents.companyId, companyId), inArray(costEvents.projectId, projectIds))),
      count(tx, financeEvents, and(eq(financeEvents.companyId, companyId), inArray(financeEvents.projectId, projectIds))),
      count(tx, projects, and(eq(projects.companyId, companyId), inArray(projects.foldedIntoProjectId, projectIds), notInArray(projects.id, projectIds))),
    ]);

    addDetach(detaches, "cost_events", "project_id", cost);
    addDetach(detaches, "finance_events", "project_id", finance);
    addDetach(detaches, "projects", "folded_into_project_id", folded);
    addDelete(deletes, "projects", projectIds.length);

    if (dryRun) return;

    await tx.update(costEvents).set({ projectId: null }).where(and(eq(costEvents.companyId, companyId), inArray(costEvents.projectId, projectIds)));
    await tx.update(financeEvents).set({ projectId: null }).where(and(eq(financeEvents.companyId, companyId), inArray(financeEvents.projectId, projectIds)));
    await tx.update(projects).set({ foldedIntoProjectId: null }).where(and(eq(projects.companyId, companyId), inArray(projects.foldedIntoProjectId, projectIds), notInArray(projects.id, projectIds)));
    // project_goals, project_memberships, project_workspaces,
    // execution_workspaces and routines all cascade from `projects`.
    await tx.delete(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));
  }

  /** Clear every pointer INTO the target goals so the referrers can survive. */
  async function detachFromGoals(
    tx: Db,
    companyId: string,
    goalIds: string[],
    detaches: DataErasureDetachCount[],
    dryRun: boolean,
  ) {
    if (goalIds.length === 0) return;
    const [byGoal, byFold, byIssue, byLink] = await Promise.all([
      count(tx, projects, and(eq(projects.companyId, companyId), inArray(projects.goalId, goalIds))),
      count(tx, projects, and(eq(projects.companyId, companyId), inArray(projects.foldedIntoGoalId, goalIds))),
      count(tx, issues, and(eq(issues.companyId, companyId), inArray(issues.goalId, goalIds))),
      count(tx, projectGoals, and(eq(projectGoals.companyId, companyId), inArray(projectGoals.goalId, goalIds))),
    ]);
    addDetach(detaches, "projects", "goal_id", byGoal);
    addDetach(detaches, "projects", "folded_into_goal_id", byFold);
    addDetach(detaches, "issues", "goal_id", byIssue);
    // The link rows themselves cascade away with the goal; counted as a
    // detachment because what the reader loses is the link, not the project.
    addDetach(detaches, "project_goals", "goal_id", byLink);

    if (dryRun) return;
    await tx.update(projects).set({ goalId: null }).where(and(eq(projects.companyId, companyId), inArray(projects.goalId, goalIds)));
    await tx.update(projects).set({ foldedIntoGoalId: null }).where(and(eq(projects.companyId, companyId), inArray(projects.foldedIntoGoalId, goalIds)));
    await tx.update(issues).set({ goalId: null }).where(and(eq(issues.companyId, companyId), inArray(issues.goalId, goalIds)));
  }

  /**
   * Delete goals plus the rows that block them. Cost and finance events are
   * detached, never deleted, at this scope: erasing an initiative does not
   * unspend its budget.
   */
  async function deleteGoals(
    tx: Db,
    companyId: string,
    goalIds: string[],
    deletes: DataErasureTableCount[],
    detaches: DataErasureDetachCount[],
    dryRun: boolean,
  ) {
    if (goalIds.length === 0) return;
    const [cost, finance, routineRefs, orphanChildren] = await Promise.all([
      count(tx, costEvents, and(eq(costEvents.companyId, companyId), inArray(costEvents.goalId, goalIds))),
      count(tx, financeEvents, and(eq(financeEvents.companyId, companyId), inArray(financeEvents.goalId, goalIds))),
      count(tx, routines, and(eq(routines.companyId, companyId), inArray(routines.goalId, goalIds))),
      count(tx, goals, and(eq(goals.companyId, companyId), inArray(goals.parentId, goalIds), notInArray(goals.id, goalIds))),
    ]);
    addDetach(detaches, "cost_events", "goal_id", cost);
    addDetach(detaches, "finance_events", "goal_id", finance);
    addDetach(detaches, "routines", "goal_id", routineRefs);
    addDetach(detaches, "goals", "parent_id", orphanChildren);
    addDelete(deletes, "goals", goalIds.length);

    if (dryRun) return;
    await tx.update(costEvents).set({ goalId: null }).where(and(eq(costEvents.companyId, companyId), inArray(costEvents.goalId, goalIds)));
    await tx.update(financeEvents).set({ goalId: null }).where(and(eq(financeEvents.companyId, companyId), inArray(financeEvents.goalId, goalIds)));
    await tx.update(routines).set({ goalId: null }).where(and(eq(routines.companyId, companyId), inArray(routines.goalId, goalIds)));
    await tx.update(goals).set({ parentId: null }).where(and(eq(goals.companyId, companyId), inArray(goals.parentId, goalIds), notInArray(goals.id, goalIds)));
    // project_goals cascades from goals.
    await tx.delete(goals).where(and(eq(goals.companyId, companyId), inArray(goals.id, goalIds)));
  }

  return {
    isExposed: isCompanyDataErasureExposed,
    erasedTableNames,
    preservedTableNames,

    /**
     * Preview or execute, in ONE transaction either way. A dry run and a
     * blocked erasure roll back explicitly rather than relying on having
     * happened not to write — so a future edit that forgets a `dryRun` guard
     * still cannot leave anything behind.
     */
    erase: async (
      companyId: string,
      input: CompanyDataErasureInput,
      actor: ErasureActor,
    ): Promise<CompanyDataErasureReport> => {
      const { company, dryRun } = await resolveTarget(companyId, input.confirm);
      const children = input.children ?? DATA_ERASURE_DEFAULT_CHILD_MODE[input.scope];

      const run = async (tx: Db): Promise<CompanyDataErasureReport> => {
        const deletes: DataErasureTableCount[] = [];
        const detaches: DataErasureDetachCount[] = [];
        let blocked: CompanyDataErasureReport["blocked"] = null;

        if (input.scope === "company") {
          for (const entry of erasureOrder()) {
            const rows = await countTable(tx, entry, companyId);
            addDelete(deletes, entry.name, rows);
            if (!dryRun && rows > 0) {
              await tx.delete(entry.table as never).where(scopeCondition(entry, companyId) as never);
            }
          }
        } else if (input.scope === "projects") {
          const projectIds = await allProjectIds(tx, companyId);
          const issueIds = await issuesInProjects(tx, companyId, projectIds);

          if (children === "block" && issueIds.length > 0) {
            blocked = {
              reason: `${projectIds.length} project(s) still hold ${issueIds.length} issue(s).`,
              counts: [{ table: "issues", rows: issueIds.length }],
              resolution:
                'Re-send with {"scope":"projects","children":"cascade"} to erase the issues too, or "detach" to keep them without a project.',
            };
          } else if (children === "detach") {
            addDetach(detaches, "issues", "project_id", issueIds.length);
            if (!dryRun && issueIds.length > 0) {
              await tx
                .update(issues)
                .set({ projectId: null })
                .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
            }
            await deleteProjects(tx, companyId, projectIds, deletes, detaches, dryRun);
          } else {
            await deleteIssues(tx, companyId, issueIds, deletes, detaches, dryRun);
            await deleteProjects(tx, companyId, projectIds, deletes, detaches, dryRun);
          }
        } else {
          const goalIds = await initiativeGoalIds(tx, companyId);
          const attachedProjectIds = await projectsAttachedToGoals(tx, companyId, goalIds);
          const referencingIssueIds = await issuesReferencingGoals(tx, companyId, goalIds);

          if (children === "block" && (attachedProjectIds.length > 0 || referencingIssueIds.length > 0)) {
            blocked = {
              reason:
                `${goalIds.length} initiative goal(s) still have ` +
                `${attachedProjectIds.length} attached project(s) and ` +
                `${referencingIssueIds.length} issue(s) pointing at them.`,
              counts: sortCounts([
                { table: "projects", rows: attachedProjectIds.length },
                { table: "issues", rows: referencingIssueIds.length },
              ]),
              resolution:
                'Re-send with {"scope":"initiatives","children":"cascade"} to erase them too, or "detach" to unlink them and keep them on the board.',
            };
          } else if (children === "cascade") {
            const projectIssueIds = await issuesInProjects(tx, companyId, attachedProjectIds);
            const allIssueIds = [...new Set([...referencingIssueIds, ...projectIssueIds])];
            await deleteIssues(tx, companyId, allIssueIds, deletes, detaches, dryRun);
            await deleteProjects(tx, companyId, attachedProjectIds, deletes, detaches, dryRun);
            await deleteGoals(tx, companyId, goalIds, deletes, detaches, dryRun);
          } else {
            await detachFromGoals(tx, companyId, goalIds, detaches, dryRun);
            await deleteGoals(tx, companyId, goalIds, deletes, detaches, dryRun);
          }
        }

        const totalRowsDeleted = deletes.reduce((sum, entry) => sum + entry.rows, 0);
        const totalRowsDetached = detaches.reduce((sum, entry) => sum + entry.rows, 0);

        let activityId: string | null = null;
        if (!dryRun && !blocked) {
          // Written INSIDE the transaction, and at company scope AFTER
          // activity_log has been emptied — so the erasure is never the one
          // event with no trace, and the trace cannot survive a rollback of
          // the erasure it describes.
          const [row] = await tx
            .insert(activityLog)
            .values({
              companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              action: DATA_ERASURE_ACTIVITY_ACTION,
              entityType: "company",
              entityId: companyId,
              ...(actor.agentId ? { agentId: actor.agentId } : {}),
              ...(actor.runId ? { runId: actor.runId } : {}),
              details: {
                scope: input.scope,
                children,
                companySlug: company.slug,
                deletes: sortCounts(deletes),
                detaches: detaches.filter((entry) => entry.rows > 0),
                totalRowsDeleted,
                totalRowsDetached,
                preserved: preservedTableNames(),
              },
            })
            .returning({ id: activityLog.id });
          activityId = row?.id ?? null;
        }

        return {
          scope: input.scope,
          children,
          dryRun,
          companyId,
          companySlug: company.slug ?? null,
          blocked,
          deletes: blocked ? [] : sortCounts(deletes),
          detaches: blocked ? [] : detaches.filter((entry) => entry.rows > 0),
          totalRowsDeleted: blocked ? 0 : totalRowsDeleted,
          totalRowsDetached: blocked ? 0 : totalRowsDetached,
          preserved: preservedTableNames(),
          activityId,
        };
      };

      try {
        return await db.transaction(async (tx) => {
          const report = await run(tx as unknown as Db);
          if (report.dryRun || report.blocked) throw new ErasureRollback(report);
          return report;
        });
      } catch (err) {
        if (err instanceof ErasureRollback) return err.report;
        throw err;
      }
    },
  };
}
