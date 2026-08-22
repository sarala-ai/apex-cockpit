/**
 * createLessonAndAmendment — closes the APEX-146/148 cohesion chain.
 *
 * Given a failing eval verdict for a run, this function:
 *   1. Creates an eval_lessons row and emits a lineage_edge eval_result→lesson
 *      (edge_type 'caused_by').
 *   2. Creates an eval_amendments row (pointing at the prompt that owns the
 *      evaluated version, status 'proposed') and emits a lineage_edge
 *      lesson→amendment (edge_type 'amends').
 *
 * Producer-owns-schema: callers MUST pass the evalResultId obtained from
 * the observe/eval READ API (ApexEvalTraceClient.getTrace) — never query
 * apex-eval's DB directly.
 *
 * Failure isolation: throws on DB errors (the caller decides whether to
 * swallow or propagate).
 */

import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { evalAmendments, evalLessons, issues, lineageEdges } from "@paperclipai/db";

export interface CreateLessonAndAmendmentParams {
  db: Db;
  companyId: string;
  /** heartbeat_runs.id — the cockpit run that observed the verdict. */
  runId: string;
  /** Cross-DB soft-ref to apex-eval's eval_results.id (UUID as text). */
  evalResultId: string;
  /** 'fail' verdict from the eval READ API. Callers should only call this for failing verdicts. */
  verdict: string;
  /** Human-readable summary of the lesson extracted from the eval. */
  summary: string;
  /** company_prompt_versions.id — the version that was evaluated. */
  promptVersionId: string;
  /** company_prompts.id — the prompt that owns the evaluated version. */
  promptId: string;
  /**
   * Explicit issueId. If omitted the function resolves it by looking up
   * issues.origin_run_id = runId within the company. Null if no match.
   */
  issueId?: string | null;
}

export interface LessonAndAmendmentResult {
  lessonId: string;
  amendmentId: string;
}

export async function createLessonAndAmendment(
  params: CreateLessonAndAmendmentParams,
): Promise<LessonAndAmendmentResult> {
  const { db, companyId, runId, evalResultId, verdict, summary, promptVersionId, promptId } = params;

  // Resolve issueId from origin_run_id if not supplied.
  let issueId = params.issueId ?? null;
  if (issueId === undefined || issueId === null) {
    const [matched] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originRunId, runId)))
      .limit(1);
    issueId = matched?.id ?? null;
  }

  // 1. Create the lesson.
  const [lesson] = await db
    .insert(evalLessons)
    .values({
      companyId,
      runId,
      issueId,
      evalResultId,
      verdict,
      summary,
    })
    .returning({ id: evalLessons.id });

  // Emit lineage_edge eval_result→lesson (caused_by).
  await db.insert(lineageEdges).values({
    companyId,
    runId,
    fromKind: "eval_result",
    fromId: evalResultId,
    toKind: "eval_lesson",
    toId: lesson.id,
    edgeType: "caused_by",
  });

  // 2. Create the amendment targeting the prompt (not the version, because
  //    the amendment recommends updating the prompt itself).
  const [amendment] = await db
    .insert(evalAmendments)
    .values({
      companyId,
      runId,
      issueId,
      lessonId: lesson.id,
      subjectKind: "prompt",
      subjectId: promptId,
      status: "proposed",
      summary: `Amend prompt in response to eval lesson: ${summary}`,
    })
    .returning({ id: evalAmendments.id });

  // Emit lineage_edge lesson→amendment (amends).
  await db.insert(lineageEdges).values({
    companyId,
    runId,
    fromKind: "eval_lesson",
    fromId: lesson.id,
    toKind: "eval_amendment",
    toId: amendment.id,
    edgeType: "amends",
  });

  return { lessonId: lesson.id, amendmentId: amendment.id };
}
