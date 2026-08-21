import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { goals, issues, projects, projectGoals } from "@paperclipai/db";

export type IntakeDuplicate = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  projectId: string | null;
};

export type IntakeProjectSuggestion = {
  id: string;
  name: string;
  goalId: string | null;
};

export type IntakeGoalSuggestion = {
  id: string;
  title: string;
};

export type IntakeEpicSuggestion = {
  id: string;
  identifier: string | null;
  title: string;
  projectId: string | null;
};

export type IntakeCheckResult = {
  duplicates: IntakeDuplicate[];
  projects: IntakeProjectSuggestion[];
  goals: IntakeGoalSuggestion[];
  epicCandidates: IntakeEpicSuggestion[];
  missing: Array<"projectId" | "goalId">;
};

const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;
const DEDUP_CANDIDATE_LIMIT = 5;
const EPIC_CANDIDATE_LIMIT = 10;
const MIN_WORD_LENGTH = 3;
const MIN_MATCHING_WORDS = 2;

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= MIN_WORD_LENGTH);
}

export async function runIntakeCheck(
  db: Db,
  companyId: string,
  title: string,
  opts: { projectId?: string | null; goalId?: string | null },
): Promise<IntakeCheckResult> {
  const keywords = extractKeywords(title);

  const [duplicates, projectRows, goalRows, epicRows] = await Promise.all([
    findDuplicates(db, companyId, title, keywords),
    db
      .select({ id: projects.id, name: projects.name, goalId: projects.goalId })
      .from(projects)
      .where(eq(projects.companyId, companyId))
      .orderBy(asc(projects.name))
      .limit(100),
    db
      .select({ id: goals.id, title: goals.title })
      .from(goals)
      .where(eq(goals.companyId, companyId))
      .orderBy(asc(goals.title))
      .limit(50),
    findEpicCandidates(db, companyId),
  ]);

  const missing: Array<"projectId" | "goalId"> = [];
  if (!opts.projectId) missing.push("projectId");
  if (!opts.goalId) missing.push("goalId");

  return {
    duplicates,
    projects: projectRows.map((r) => ({ id: r.id, name: r.name ?? "", goalId: r.goalId ?? null })),
    goals: goalRows.map((r) => ({ id: r.id, title: r.title })),
    epicCandidates: epicRows,
    missing,
  };
}

async function findDuplicates(
  db: Db,
  companyId: string,
  title: string,
  keywords: string[],
): Promise<IntakeDuplicate[]> {
  if (keywords.length === 0) return [];

  // Build a scoring expression: count how many keywords appear in the title.
  // Require at least MIN_MATCHING_WORDS to surface a candidate.
  const keywordPatterns = keywords.map((k) => `%${k}%`);
  const matchCountExpr = sql<number>`(
    ${sql.join(
      keywordPatterns.map((p) => sql`(CASE WHEN lower(${issues.title}) LIKE ${p} THEN 1 ELSE 0 END)`),
      sql` + `,
    )}
  )`;

  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      projectId: issues.projectId,
      matchCount: matchCountExpr,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.status, [...OPEN_STATUSES]),
        sql`lower(${issues.title}) != ${title.toLowerCase()}`,
      ),
    )
    .orderBy(sql`match_count DESC`)
    .limit(DEDUP_CANDIDATE_LIMIT * 3); // over-fetch, then filter

  return rows
    .filter((r) => (r.matchCount as number) >= MIN_MATCHING_WORDS)
    .slice(0, DEDUP_CANDIDATE_LIMIT)
    .map((r) => ({
      id: r.id,
      identifier: r.identifier ?? null,
      title: r.title,
      status: r.status,
      projectId: r.projectId ?? null,
    }));
}

async function findEpicCandidates(db: Db, companyId: string): Promise<IntakeEpicSuggestion[]> {
  // An issue is an "epic candidate" if it has open children or is explicitly
  // typed as a feature/design-change (long-running work).
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.status, [...OPEN_STATUSES]),
        isNull(issues.parentId),
        sql`EXISTS (
          SELECT 1 FROM issues child
          WHERE child.parent_id = ${issues.id}
            AND child.company_id = ${companyId}
            AND child.status NOT IN ('done', 'cancelled')
        )`,
      ),
    )
    .orderBy(asc(issues.title))
    .limit(EPIC_CANDIDATE_LIMIT);

  return rows.map((r) => ({
    id: r.id,
    identifier: r.identifier ?? null,
    title: r.title,
    projectId: r.projectId ?? null,
  }));
}
