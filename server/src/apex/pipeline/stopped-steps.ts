/**
 * The stopped work a person has to be TOLD about.
 *
 * `readActiveStepHold` already answers "has this one case stopped?", and two
 * surfaces read it: the ticket and the pipeline item page. Both require you to
 * already be looking at the thing that stopped. Until this module existed, a
 * process could stop, explain itself perfectly, and reach nobody — the gap
 * recorded in `lifecycles.ts` ("no notification, no inbox item and no sidebar
 * badge").
 *
 * WHAT COUNTS. A hold, and only a hold. Migration 0170 drew the line and this
 * module keeps it: `step_held` is a REFUSAL to advance that a transition gate
 * enforces, while `step_waiting` is the ordinary in-flight state of a case
 * parked on an agent that is working. The first needs a human; the second
 * needs patience. Counting the second would put a permanent number on the
 * sidebar that means "work is happening", and a badge that is always lit is a
 * badge nobody reads.
 *
 * Two exclusions follow from the same rule and are deliberate:
 *  - A TERMINAL case is history. Its last hold cannot be acted on and must not
 *    look urgent — the same judgement `shapeIssueLinkedCase` already makes.
 *  - A GATE waiting on a decision is not stopped, it is asking. It surfaces as
 *    an approval already, and counting it twice would double every pending
 *    decision on the sidebar.
 *
 * A FAILED AUTOMATION needs no separate signal. A run or agent step that fails
 * with no failure route writes a hold (`services/pipelines.ts` §"with no
 * failure route HOLDS the stage"); one WITH a failure route was handled by the
 * process and is not a problem. So "held" already means "failed and nobody
 * caught it", which is exactly the set worth interrupting somebody for.
 *
 * HOW IT CLEARS. Nothing here is stored and nothing is dismissible. Every
 * answer is re-derived from events on each read, so a hold stops being
 * reported the moment it is cleared, the step is re-run, the case moves on, or
 * the case ends — with nobody having to tick anything off. That is the same
 * behaviour the block on the ticket already has, and matching it is the point:
 * a signal that outlives its cause is how a signal becomes noise.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  companies,
  companyMemberships,
  issues,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
} from "@paperclipai/db";
import type { PipelineStepHold } from "@paperclipai/shared";
import { readActiveStepHold } from "../../services/pipelines.js";
import { shapeStepHold } from "./step-hold.js";

type AnyDb = any;

/** One stopped step, with the ticket it belongs to and the person on the hook. */
export interface StoppedStep {
  caseId: string;
  caseKey: string;
  pipelineId: string;
  stageName: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
  } | null;
  /**
   * The human this is FOR. Never the step's owner: a held step's owner is
   * routinely an agent, and an agent cannot act on a badge in somebody's
   * sidebar. See {@link resolveStoppedStepAudience}.
   */
  responsibleUserId: string | null;
  hold: PipelineStepHold;
}

/**
 * Who a stopped step is for.
 *
 * This is not a new idea about responsibility — it is the ladder the codebase
 * already climbs when it has to name an accountable human for work an agent is
 * doing (`resolveRoutineResponsibleUserId`, services/routines.ts): the
 * ticket's responsible user, else whoever raised it, else the company owner.
 *
 * The last rung matters. A ticket with no named human still stops, and a
 * stopped step that resolves to nobody is the original bug wearing a different
 * hat, so it lands on the board owner rather than nowhere.
 */
export function resolveStoppedStepAudience(
  issue: { responsibleUserId: string | null; createdByUserId: string | null } | null,
  companyFallbackUserId: string | null,
): string | null {
  return issue?.responsibleUserId ?? issue?.createdByUserId ?? companyFallbackUserId ?? null;
}

/**
 * The company's fallback human — its configured default, else its owner.
 *
 * Lifted verbatim from `resolveCompanyDefaultResponsibleUserId`
 * (services/routines.ts) rather than invented, so a stopped step lands on the
 * same desk a routine with no named human already lands on.
 */
async function companyFallbackUserId(db: AnyDb, companyId: string): Promise<string | null> {
  const company = await db
    .select({ defaultResponsibleUserId: companies.defaultResponsibleUserId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows: Array<{ defaultResponsibleUserId: string | null }>) => rows[0] ?? null);
  if (company?.defaultResponsibleUserId) return company.defaultResponsibleUserId;

  const owner = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(and(
      eq(companyMemberships.companyId, companyId),
      eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"),
    ))
    .orderBy(companyMemberships.createdAt, companyMemberships.id)
    .limit(1)
    .then((rows: Array<{ userId: string }>) => rows[0] ?? null);
  return owner?.userId ?? null;
}

/**
 * Every stopped step in the company, cheapest-first.
 *
 * Two passes on purpose. The first is a single indexed query that narrows the
 * whole company down to the cases that have EVER written a hold at the step
 * they are currently sitting on — on a healthy board that is zero rows, and a
 * healthy board is the common case that must not be paid for. Only those
 * candidates then pay for `readActiveStepHold`, which is the query that knows
 * about clearing and is the one this must not re-implement: two spellings of
 * "is this hold live" is how the sidebar and the ticket come to disagree about
 * the same case.
 */
export async function listStoppedSteps(db: AnyDb, companyId: string): Promise<StoppedStep[]> {
  const candidates = await db
    .select({
      case: pipelineCases,
      stage: pipelineStages,
    })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .where(and(
      eq(pipelineCases.companyId, companyId),
      isNull(pipelineCases.terminalKind),
      isNull(pipelineCases.retiredAt),
      // A gate is asking, not stopped — it is already an approval.
      sql`${pipelineStages.kind} <> 'review'`,
      sql`exists (
        select 1 from ${pipelineCaseEvents}
        where ${pipelineCaseEvents.caseId} = ${pipelineCases.id}
          and ${pipelineCaseEvents.type} = 'step_held'
          and ${pipelineCaseEvents.payload}->>'stageId' = ${pipelineCases.stageId}::text
      )`,
    ));

  if (candidates.length === 0) return [];

  const held = (await Promise.all(candidates.map(async (row: any) => {
    const hold = shapeStepHold(
      await readActiveStepHold(db, row.case, row.stage),
      { stageName: row.stage.name },
    );
    return hold ? { row, hold } : null;
  }))).filter(Boolean) as Array<{ row: any; hold: PipelineStepHold }>;

  if (held.length === 0) return [];

  // The ticket a stopped step belongs to, via the `work` link — the same link
  // the ticket's own lifecycle strip reports on. A case with no live work link
  // still counts: something has stopped whether or not a ticket points at it.
  const caseIds = held.map((entry) => entry.row.case.id);
  const linkRows = await db
    .select({
      caseId: pipelineCaseIssueLinks.caseId,
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      responsibleUserId: issues.responsibleUserId,
      createdByUserId: issues.createdByUserId,
    })
    .from(pipelineCaseIssueLinks)
    .innerJoin(issues, eq(pipelineCaseIssueLinks.issueId, issues.id))
    .where(and(
      eq(pipelineCaseIssueLinks.companyId, companyId),
      inArray(pipelineCaseIssueLinks.caseId, caseIds),
      eq(pipelineCaseIssueLinks.role, "work"),
      isNull(pipelineCaseIssueLinks.retiredAt),
    ));
  const issueByCaseId = new Map<string, (typeof linkRows)[number]>(
    linkRows.map((row: any) => [row.caseId, row]),
  );

  const fallbackUserId = await companyFallbackUserId(db, companyId);

  return held.map(({ row, hold }) => {
    const issue = issueByCaseId.get(row.case.id) ?? null;
    return {
      caseId: row.case.id,
      caseKey: row.case.caseKey,
      pipelineId: row.case.pipelineId,
      stageName: row.stage.name,
      issue: issue
        ? { id: issue.id, identifier: issue.identifier, title: issue.title }
        : null,
      responsibleUserId: resolveStoppedStepAudience(issue, fallbackUserId),
      hold,
    };
  }).sort((left, right) => right.hold.heldAt.localeCompare(left.hold.heldAt));
}

/**
 * How many stopped steps this person is on the hook for.
 *
 * `null` for a caller who is not a board user (an agent, a service key): an
 * agent cannot read a sidebar, so counting for one would inflate a number
 * nobody looks at. Such callers get the company-wide total instead, which is
 * what the dashboard tile shows.
 */
export function countStoppedStepsForUser(steps: StoppedStep[], userId: string | null | undefined): number {
  if (!userId) return steps.length;
  return steps.filter((step) => step.responsibleUserId === userId).length;
}
