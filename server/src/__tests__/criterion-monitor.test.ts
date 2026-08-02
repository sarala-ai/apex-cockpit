import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, approvals, companies, createDb, goals } from "@paperclipai/db";
import type { GoalValidationCriterion } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CRITERION_REVIEW_APPROVAL_TYPE,
  CRITERION_SWEEP_ENV_VAR,
  criterionMonitor,
  criterionSweepIntervalMs,
  startCriterionReviewSweep,
} from "../services/criterion-monitor.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres criterion monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// --- scheduling: the house periodic-job shape ------------------------------

describe("criterionSweepIntervalMs", () => {
  it("defaults to hourly — a review date is a day, not a minute", () => {
    expect(criterionSweepIntervalMs({})).toBe(3_600_000);
  });

  it("honors the env var", () => {
    expect(criterionSweepIntervalMs({ [CRITERION_SWEEP_ENV_VAR]: "6" })).toBe(6 * 3_600_000);
  });

  it("0 disables; garbage and negatives fall back to the default", () => {
    expect(criterionSweepIntervalMs({ [CRITERION_SWEEP_ENV_VAR]: "0" })).toBe(0);
    expect(criterionSweepIntervalMs({ [CRITERION_SWEEP_ENV_VAR]: "nope" })).toBe(3_600_000);
    expect(criterionSweepIntervalMs({ [CRITERION_SWEEP_ENV_VAR]: "-2" })).toBe(3_600_000);
  });
});

describe("startCriterionReviewSweep", () => {
  it("ticks on the interval and stops when disposed", async () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.fn(async () => ({ surfaced: 0, skipped: 0 }));
      const stop = startCriterionReviewSweep({} as never, {
        monitor: { sweep } as never,
        intervalMs: 60_000,
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sweep).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(sweep).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("interval 0 never runs", () => {
    const sweep = vi.fn(async () => ({ surfaced: 0, skipped: 0 }));
    const stop = startCriterionReviewSweep({} as never, {
      monitor: { sweep } as never,
      intervalMs: 0,
    });
    stop();
    expect(sweep).not.toHaveBeenCalled();
  });
});

// --- the sweep itself ------------------------------------------------------

describeEmbeddedPostgres("criterion review sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const NOW = new Date("2026-08-02T09:00:00Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-criterion-monitor-");
    db = createDb(tempDb.connectionString);
  }, 40_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvals);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "APEX",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  function criterion(overrides: Partial<GoalValidationCriterion> = {}): GoalValidationCriterion {
    return {
      id: "c1",
      statement: "Agents reach for tools rather than freelancing",
      measure: "tool calls / total assistant turns, over apex-eval traces",
      threshold: "≥80%",
      window: "first four weeks after release",
      ownerUserId: "srinivas",
      reviewDate: "2026-08-01",
      status: "pending",
      ...overrides,
    };
  }

  async function seedInitiative(
    companyId: string,
    validationCriteria: GoalValidationCriterion[],
    level = "initiative",
  ) {
    const id = randomUUID();
    await db.insert(goals).values({
      id,
      companyId,
      title: "Every interface generated from MCP tools",
      level,
      status: "active",
      validationCriteria,
    });
    return id;
  }

  const readCriteria = async (goalId: string) =>
    db
      .select({ validationCriteria: goals.validationCriteria })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => (rows[0]?.validationCriteria ?? []) as GoalValidationCriterion[]);

  const readApprovals = async (companyId: string) =>
    db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.type, CRITERION_REVIEW_APPROVAL_TYPE),
        ),
      );

  it("surfaces a due criterion to a user owner as a pending board item", async () => {
    const companyId = await seedCompany();
    const goalId = await seedInitiative(companyId, [criterion()]);

    const result = await criterionMonitor(db).sweep(NOW);

    expect(result).toEqual({ surfaced: 1, skipped: 0 });
    const raised = await readApprovals(companyId);
    expect(raised).toHaveLength(1);
    expect(raised[0]!.status).toBe("pending");
    // The prompt has to carry the question, not just a pointer to it.
    expect(raised[0]!.payload).toMatchObject({
      goalId,
      criterionId: "c1",
      statement: "Agents reach for tools rather than freelancing",
      threshold: "≥80%",
      reportPath: `/api/goals/${goalId}/criteria/c1/report`,
    });
  });

  it("records that it surfaced, in the activity log", async () => {
    const companyId = await seedCompany();
    const goalId = await seedInitiative(companyId, [criterion()]);

    await criterionMonitor(db).sweep(NOW);

    const entries = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "goal.criterion_surfaced"));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityId).toBe(goalId);
    expect(entries[0]!.details).toMatchObject({ criterionId: "c1", threshold: "≥80%" });
  });

  it("wakes an agent owner instead, carrying an idempotency key", async () => {
    const companyId = await seedCompany();
    const agentId = randomUUID();
    const goalId = await seedInitiative(companyId, [
      criterion({ ownerUserId: null, ownerAgentId: agentId }),
    ]);
    const wakeup = vi.fn(async () => ({}));

    const result = await criterionMonitor(db, { wakeup }).sweep(NOW);

    expect(result.surfaced).toBe(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]![0]).toBe(agentId);
    expect(wakeup.mock.calls[0]![1]).toMatchObject({
      source: "automation",
      idempotencyKey: `criterion-review:${goalId}:c1`,
    });
    // An agent owner gets a wakeup, not a board item — the inbox is for people.
    expect(await readApprovals(companyId)).toHaveLength(0);
  });

  it("does not surface a criterion whose review date has not arrived", async () => {
    const companyId = await seedCompany();
    await seedInitiative(companyId, [criterion({ reviewDate: "2026-09-01" })]);

    expect(await criterionMonitor(db).sweep(NOW)).toEqual({ surfaced: 0, skipped: 0 });
    expect(await readApprovals(companyId)).toHaveLength(0);
  });

  it("does not re-surface a criterion that was already reported against", async () => {
    const companyId = await seedCompany();
    await seedInitiative(companyId, [
      criterion({ status: "hit", reviewedAt: "2026-08-01T10:00:00Z", reviewNote: "84%" }),
      criterion({ id: "c2", status: "missed", reviewedAt: "2026-08-01T10:00:00Z" }),
    ]);

    expect(await criterionMonitor(db).sweep(NOW)).toEqual({ surfaced: 0, skipped: 0 });
    expect(await readApprovals(companyId)).toHaveLength(0);
  });

  it("never surfaces a never_registered criterion — there is nothing to look at", async () => {
    const companyId = await seedCompany();
    await seedInitiative(companyId, [
      {
        id: "c1",
        statement: "No validation criteria were registered for this initiative",
        status: "never_registered",
      },
    ]);

    expect(await criterionMonitor(db).sweep(NOW)).toEqual({ surfaced: 0, skipped: 0 });
    expect(await readApprovals(companyId)).toHaveLength(0);
  });

  it("is idempotent across two sweeps: a due criterion surfaces once", async () => {
    const companyId = await seedCompany();
    const goalId = await seedInitiative(companyId, [criterion()]);
    const monitor = criterionMonitor(db);

    expect(await monitor.sweep(NOW)).toEqual({ surfaced: 1, skipped: 0 });
    // surfacedAt is stamped in the same row as the criteria, so "has this been
    // surfaced" is answered by the record rather than a side table that drifts.
    expect((await readCriteria(goalId))[0]!.surfacedAt).toBe(NOW.toISOString());

    const second = await monitor.sweep(new Date("2026-08-03T09:00:00Z"));
    expect(second).toEqual({ surfaced: 0, skipped: 0 });
    expect(await readApprovals(companyId)).toHaveLength(1);
  });

  it("does not duplicate the board item if the stamp was lost mid-sweep", async () => {
    // The crash case: notified, then died before stamping. The open approval is
    // the second line of defence behind surfacedAt.
    const companyId = await seedCompany();
    const goalId = await seedInitiative(companyId, [criterion()]);
    const monitor = criterionMonitor(db);
    await monitor.sweep(NOW);

    const criteria = await readCriteria(goalId);
    await db
      .update(goals)
      .set({ validationCriteria: criteria.map((c) => ({ ...c, surfacedAt: null })) })
      .where(eq(goals.id, goalId));

    await monitor.sweep(NOW);
    expect(await readApprovals(companyId)).toHaveLength(1);
  });

  it("ignores criteria on goals that are not initiatives", async () => {
    const companyId = await seedCompany();
    // Nothing can write this through the API; the sweep still must not act on
    // it if a fixture or an older client ever put it there.
    await seedInitiative(companyId, [criterion()], "team");

    expect(await criterionMonitor(db).sweep(NOW)).toEqual({ surfaced: 0, skipped: 0 });
    expect(await readApprovals(companyId)).toHaveLength(0);
  });

  it("counts an unreachable owner as skipped and retries it next sweep", async () => {
    // An agent-owned criterion with no wakeup wired (heartbeat scheduler off).
    // It must not be stamped, so it surfaces once the dep exists.
    const companyId = await seedCompany();
    const goalId = await seedInitiative(companyId, [
      criterion({ ownerUserId: null, ownerAgentId: randomUUID() }),
    ]);

    expect(await criterionMonitor(db).sweep(NOW)).toEqual({ surfaced: 0, skipped: 1 });
    expect((await readCriteria(goalId))[0]!.surfacedAt).toBeFalsy();

    const wakeup = vi.fn(async () => ({}));
    expect(await criterionMonitor(db, { wakeup }).sweep(NOW)).toEqual({ surfaced: 1, skipped: 0 });
  });

  it("closes the board item when a verdict is reported", async () => {
    const companyId = await seedCompany();
    const goalId = await seedInitiative(companyId, [criterion()]);
    const monitor = criterionMonitor(db);
    await monitor.sweep(NOW);

    await monitor.closeReviewApprovals(goalId, "c1", "srinivas", "criterion reported hit: 84%");

    const raised = await readApprovals(companyId);
    expect(raised[0]!.status).toBe("approved");
    expect(raised[0]!.decidedByUserId).toBe("srinivas");
    expect(raised[0]!.decisionNote).toContain("hit");
  });
});
