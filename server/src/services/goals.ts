import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, projects, projectGoals } from "@paperclipai/db";
import {
  deriveInitiativeStatus,
  summarizeInitiativeProjects,
  type InitiativeDerivedStatus,
  type InitiativeProjectCounts,
} from "@paperclipai/shared";

type GoalReader = Pick<Db, "select">;

/**
 * Project statuses per goal, across BOTH ways a project can point at a goal:
 * the legacy `projects.goal_id` column and the `project_goals` join table. A
 * derived status that only saw one of them would under-report, which is worse
 * than not deriving at all.
 */
async function projectStatusesByGoal(
  db: GoalReader,
  goalIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byGoal = new Map<string, string[]>();
  if (goalIds.length === 0) return byGoal;

  const ids = [...goalIds];

  const [direct, joined] = await Promise.all([
    db
      .select({ goalId: projects.goalId, projectId: projects.id, status: projects.status })
      .from(projects)
      .where(inArray(projects.goalId, ids)),
    db
      .select({
        goalId: projectGoals.goalId,
        projectId: projects.id,
        status: projects.status,
      })
      .from(projectGoals)
      .innerJoin(projects, eq(projects.id, projectGoals.projectId))
      .where(inArray(projectGoals.goalId, ids)),
  ]);

  // A project linked both ways must count once, not twice.
  const seen = new Set<string>();
  for (const row of [...direct, ...joined]) {
    if (!row.goalId) continue;
    const key = `${row.goalId}:${row.projectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byGoal.get(row.goalId) ?? [];
    list.push(row.status);
    byGoal.set(row.goalId, list);
  }
  return byGoal;
}

type GoalRow = { id: string; level: string; hold?: unknown };

/**
 * Attach `derivedStatus` and `projectCounts` to every initiative in the set.
 * Non-initiative goals get null for both: the concepts do not apply to them and
 * inventing values would make company/team/agent/task goals look like something
 * they are not.
 *
 * The stored `hold` marker is passed into the derivation, where it OVERRIDES
 * the reading. It is the one part of an initiative's status that is decided
 * rather than computed, and the row is the only place that decision exists.
 *
 * `projectCounts` travels beside the status because the status alone can imply
 * completeness it does not have: `delivered` says nothing about the two
 * projects that were cancelled to get there, or the three that were built and
 * never exercised. The counts are what stop the board overstating.
 */
export async function withDerivedStatus<T extends GoalRow>(
  db: GoalReader,
  rows: readonly T[],
): Promise<
  Array<
    T & {
      derivedStatus: InitiativeDerivedStatus | null;
      projectCounts: InitiativeProjectCounts | null;
    }
  >
> {
  const initiativeIds = rows.filter((row) => row.level === "initiative").map((row) => row.id);
  const byGoal = await projectStatusesByGoal(db, initiativeIds);
  return rows.map((row) => {
    if (row.level !== "initiative") {
      return { ...row, derivedStatus: null, projectCounts: null };
    }
    const statuses = byGoal.get(row.id) ?? [];
    return {
      ...row,
      derivedStatus: deriveInitiativeStatus(statuses, { held: Boolean(row.hold) }),
      projectCounts: summarizeInitiativeProjects(statuses),
    };
  });
}

export async function getDefaultCompanyGoal(db: GoalReader, companyId: string) {
  const activeRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        eq(goals.status, "active"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (activeRootGoal) return activeRootGoal;

  const anyRootGoal = await db
    .select()
    .from(goals)
    .where(
      and(
        eq(goals.companyId, companyId),
        eq(goals.level, "company"),
        isNull(goals.parentId),
      ),
    )
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
  if (anyRootGoal) return anyRootGoal;

  return db
    .select()
    .from(goals)
    .where(and(eq(goals.companyId, companyId), eq(goals.level, "company")))
    .orderBy(asc(goals.createdAt))
    .then((rows) => rows[0] ?? null);
}

export function goalService(db: Db) {
  return {
    list: (companyId: string) => db.select().from(goals).where(eq(goals.companyId, companyId)),

    getById: (id: string) =>
      db
        .select()
        .from(goals)
        .where(eq(goals.id, id))
        .then((rows) => rows[0] ?? null),

    getDefaultCompanyGoal: (companyId: string) => getDefaultCompanyGoal(db, companyId),

    /** Rows in, rows out with the derived reading filled in for initiatives. */
    withDerivedStatus: <T extends { id: string; level: string; hold?: unknown }>(
      rows: readonly T[],
    ) => withDerivedStatus(db, rows),

    create: (companyId: string, data: Omit<typeof goals.$inferInsert, "companyId">) =>
      db
        .insert(goals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof goals.$inferInsert>) =>
      db
        .update(goals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    remove: (id: string) =>
      db
        .delete(goals)
        .where(eq(goals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),
  };
}
