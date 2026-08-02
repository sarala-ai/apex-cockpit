/**
 * The monitor that reads pre-registered criteria back.
 *
 * APEX wrote ~40 numbered success criteria across 21 specs and reported
 * against none of them. Writing them was never the gap — nothing ever looked.
 * This is the thing that looks: a periodic sweep that finds criteria whose
 * `reviewDate` has arrived while they are still `pending`, and puts them in
 * front of the reader who was named when the criterion was written.
 *
 * It is deliberately small. It does not evaluate a threshold, compute a
 * verdict, or decide anything: `measure` and `threshold` are free text and the
 * comparison is a human judgement (see `goalValidationCriterionSchema`). The
 * sweep's entire job is to make sure a person or an agent is asked the
 * question on the day they said they would answer it.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, goals } from "@paperclipai/db";
import {
  criterionReviewKey,
  needsSurfacing,
  type GoalValidationCriterion,
} from "@paperclipai/shared";
import { startPeriodicJob } from "../lib/periodic-job.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

export const CRITERION_SWEEP_ENV_VAR = "APEX_CRITERION_REVIEW_HOURS";
/**
 * Hourly. A review date is a day, not a minute — anything finer is noise, and
 * anything coarser risks a criterion arriving a day late in the reader's
 * timezone.
 */
const DEFAULT_SWEEP_HOURS = 1;

export const CRITERION_REVIEW_APPROVAL_TYPE = "criterion_review";

export interface CriterionMonitorDeps {
  /**
   * `heartbeatService(db).wakeup`. Injected rather than imported so the sweep
   * can be tested without the heartbeat, and so the server keeps one wakeup
   * implementation. Wired at startup; absent means agent-owned criteria are
   * skipped rather than silently lost (they stay unsurfaced and surface on the
   * next sweep once the dep is present).
   */
  wakeup?: (
    agentId: string,
    opts: {
      source?: "timer" | "assignment" | "on_demand" | "automation";
      triggerDetail?: "manual" | "ping" | "callback" | "system";
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      idempotencyKey?: string | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
    },
  ) => Promise<unknown>;
}

export interface CriterionSweepResult {
  /** Criteria that reached a reader on this pass. */
  surfaced: number;
  /** Criteria that were due but could not be surfaced (no owner reachable). */
  skipped: number;
}

type GoalRow = typeof goals.$inferSelect;

/** The payload an owner sees. Carries the question and how to answer it. */
export function criterionReviewPayload(
  goal: Pick<GoalRow, "id" | "title">,
  criterion: GoalValidationCriterion,
): Record<string, unknown> {
  return {
    goalId: goal.id,
    goalTitle: goal.title,
    criterionId: criterion.id,
    statement: criterion.statement,
    measure: criterion.measure ?? null,
    threshold: criterion.threshold ?? null,
    window: criterion.window ?? null,
    reviewDate: criterion.reviewDate ?? null,
    ownerUserId: criterion.ownerUserId ?? null,
    ownerAgentId: criterion.ownerAgentId ?? null,
    // The direct action: one POST records the verdict and closes this item.
    // Without it the notification is another thing to read and not act on.
    reportPath: `/api/goals/${goal.id}/criteria/${criterion.id}/report`,
    reportMethod: "POST",
    reportBody: { status: "hit | missed", reviewNote: "what you saw" },
  };
}

/**
 * Is there already an open review item for this criterion? Second line of
 * idempotency behind `surfacedAt`: if the process dies between notifying and
 * stamping, the next sweep must not raise a duplicate.
 */
async function hasOpenReviewApproval(db: Db, goalId: string, criterionId: string) {
  const rows = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.type, CRITERION_REVIEW_APPROVAL_TYPE),
        inArray(approvals.status, ["pending", "revision_requested"]),
        sql`${approvals.payload} ->> 'goalId' = ${goalId}`,
        sql`${approvals.payload} ->> 'criterionId' = ${criterionId}`,
      ),
    );
  return rows.length > 0;
}

export function criterionMonitor(db: Db, deps: CriterionMonitorDeps = {}) {
  /**
   * Surface one due criterion to its owner(s). Returns true when at least one
   * reader was reached — only then is the criterion stamped as surfaced, so a
   * failed notification is retried on the next tick rather than lost.
   */
  async function surface(goal: GoalRow, criterion: GoalValidationCriterion): Promise<boolean> {
    let reached = false;

    if (criterion.ownerUserId) {
      // Approvals are what the board counts as a pending item (see
      // sidebarBadgeService), so this is how a criterion reaches a person's
      // inbox. The approval is a prompt, not the verdict store — the verdict
      // lands on the criterion itself.
      if (await hasOpenReviewApproval(db, goal.id, criterion.id)) {
        reached = true;
      } else {
        await db.insert(approvals).values({
          companyId: goal.companyId,
          type: CRITERION_REVIEW_APPROVAL_TYPE,
          status: "pending",
          requestedByUserId: null,
          payload: criterionReviewPayload(goal, criterion),
        });
        reached = true;
      }
    }

    if (criterion.ownerAgentId && deps.wakeup) {
      await deps.wakeup(criterion.ownerAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: `validation criterion due for review: ${criterion.statement}`,
        payload: criterionReviewPayload(goal, criterion),
        // The heartbeat coalesces on this, so a repeat wake for the same
        // criterion cannot queue a second run.
        idempotencyKey: criterionReviewKey(goal.id, criterion.id),
        requestedByActorType: "system",
        requestedByActorId: "criterion-review-sweep",
      });
      reached = true;
    }

    if (!reached) return false;

    // The record that it surfaced. Without this line the loop is invisible
    // again — "nothing read them back" was only knowable in hindsight because
    // nothing was written down when it should have been.
    await logActivity(db, {
      companyId: goal.companyId,
      actorType: "system",
      actorId: "criterion-review-sweep",
      action: "goal.criterion_surfaced",
      entityType: "goal",
      entityId: goal.id,
      details: {
        criterionId: criterion.id,
        statement: criterion.statement,
        threshold: criterion.threshold ?? null,
        reviewDate: criterion.reviewDate ?? null,
        ownerUserId: criterion.ownerUserId ?? null,
        ownerAgentId: criterion.ownerAgentId ?? null,
      },
    });
    return true;
  }

  return {
    /**
     * One pass. Finds every initiative carrying criteria, surfaces the ones
     * that are due and not yet surfaced, and stamps `surfacedAt` so the next
     * pass leaves them alone. Idempotent by construction: the stamp is written
     * in the same row as the criteria, so "has this been surfaced" is answered
     * by the record itself rather than by a side table that can drift.
     */
    sweep: async (now: Date = new Date()): Promise<CriterionSweepResult> => {
      const rows = await db
        .select()
        .from(goals)
        .where(and(eq(goals.level, "initiative"), isNotNull(goals.validationCriteria)));

      let surfaced = 0;
      let skipped = 0;

      for (const goal of rows) {
        const criteria = (goal.validationCriteria ?? []) as GoalValidationCriterion[];
        if (criteria.length === 0) continue;

        const due = criteria.filter((criterion) => needsSurfacing(criterion, now));
        if (due.length === 0) continue;

        const stampedIds = new Set<string>();
        for (const criterion of due) {
          try {
            if (await surface(goal, criterion)) {
              stampedIds.add(criterion.id);
              surfaced += 1;
            } else {
              skipped += 1;
            }
          } catch (err) {
            // One unreachable owner must not stop the rest of the sweep — the
            // whole point is that criteria stop being silently skipped.
            skipped += 1;
            logger.warn(
              { err, goalId: goal.id, criterionId: criterion.id },
              "failed to surface a due validation criterion",
            );
          }
        }

        if (stampedIds.size === 0) continue;
        const stampedAt = now.toISOString();
        const next = criteria.map((criterion) =>
          stampedIds.has(criterion.id) ? { ...criterion, surfacedAt: stampedAt } : criterion,
        );
        await db
          .update(goals)
          .set({ validationCriteria: next, updatedAt: new Date() })
          .where(eq(goals.id, goal.id));
      }

      if (surfaced > 0 || skipped > 0) {
        logger.info({ surfaced, skipped }, "criterion review sweep");
      }
      return { surfaced, skipped };
    },

    /**
     * Resolve the inbox item raised for a criterion once a verdict is
     * recorded. The approval carried the question; the criterion carries the
     * answer, so this closes the prompt rather than storing anything.
     */
    closeReviewApprovals: async (
      goalId: string,
      criterionId: string,
      decidedByUserId: string,
      decisionNote: string,
    ) => {
      const now = new Date();
      await db
        .update(approvals)
        .set({ status: "approved", decidedByUserId, decisionNote, decidedAt: now, updatedAt: now })
        .where(
          and(
            eq(approvals.type, CRITERION_REVIEW_APPROVAL_TYPE),
            inArray(approvals.status, ["pending", "revision_requested"]),
            sql`${approvals.payload} ->> 'goalId' = ${goalId}`,
            sql`${approvals.payload} ->> 'criterionId' = ${criterionId}`,
          ),
        );
    },
  };
}

export type CriterionMonitor = ReturnType<typeof criterionMonitor>;

export function criterionSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CRITERION_SWEEP_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_SWEEP_HOURS * 3_600_000;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_SWEEP_HOURS * 3_600_000;
  return hours * 3_600_000;
}

export function startCriterionReviewSweep(
  db: Db,
  options: { monitor?: CriterionMonitor; intervalMs?: number; deps?: CriterionMonitorDeps } = {},
): () => void {
  const intervalMs = options.intervalMs ?? criterionSweepIntervalMs();
  const monitor = options.monitor ?? criterionMonitor(db, options.deps ?? {});
  return startPeriodicJob({
    name: "criterion-review-sweep",
    envVar: CRITERION_SWEEP_ENV_VAR,
    defaultHours: DEFAULT_SWEEP_HOURS,
    intervalMs,
    initialDelayMs: Math.min(intervalMs, 60_000),
    run: () => monitor.sweep(),
  });
}
