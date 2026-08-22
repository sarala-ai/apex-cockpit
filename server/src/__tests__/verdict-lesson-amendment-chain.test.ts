/**
 * APEX-148 — Full chain walk: verdict → lesson → amendment (closes the APEX-146 chain).
 *
 * Verifies:
 *   A) createLessonAndAmendment writes eval_lesson + eval_amendment rows with
 *      correct fields (run_id, eval_result_id, verdict, lesson_id, subject_kind,
 *      status).
 *   B) Two lineage_edges are emitted:
 *        eval_result  → eval_lesson   (caused_by)
 *        eval_lesson  → eval_amendment (amends)
 *   C) Full chain is walkable via recursive CTE backward from amendment:
 *        amendment ← lesson ← eval_result ← prompt_version
 *      (the pre-existing edge prompt_version→eval_result is set up in the test).
 *   D) eval_lesson.run_id resolves to a heartbeat_run row (FK integrity).
 *   E) An issue with origin_run_id = lesson.run_id exists (FK integrity).
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import {
  agents,
  companies,
  companyPrompts,
  companyPromptVersions,
  createDb,
  evalAmendments,
  evalLessons,
  heartbeatRuns,
  issues,
  lineageEdges,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLessonAndAmendment } from "../observe/lesson-amendment.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping APEX-148 chain walk tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("APEX-148: verdict → lesson → amendment full chain", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex148-chain-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "APEX-148 Chain Test Co",
      issuePrefix: `A148${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Chain Test Agent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("creates lesson + amendment rows and walks the full chain from amendment back to prompt_version", async () => {
    const runId = randomUUID();
    // eval_result lives in apex-eval's DB; we reference it by its UUID as a text soft-ref.
    const evalResultId = randomUUID();

    // ── Fixtures ────────────────────────────────────────────────────────────
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "active",
    });

    const [issue] = await db
      .insert(issues)
      .values({
        companyId,
        title: "APEX-148 test issue",
        status: "todo",
        originRunId: runId,
        originRunKind: "heartbeat_run",
      })
      .returning();

    const [prompt] = await db
      .insert(companyPrompts)
      .values({ companyId, name: "Eval Test Prompt", slug: "eval-test-prompt" })
      .returning();

    const [promptVersion] = await db
      .insert(companyPromptVersions)
      .values({
        companyId,
        promptId: prompt.id,
        revisionNumber: 1,
        content: "You are an assistant. {{task}}",
        variables: [],
        runId,
        producerKind: "agent",
        producerId: agentId,
      })
      .returning();

    // Pre-existing edge: prompt_version → eval_result (the version was evaluated).
    // This is what "the chain today" provides for eval_result→prompt_version.
    await db.insert(lineageEdges).values({
      companyId,
      runId,
      fromKind: "prompt_version",
      fromId: promptVersion.id,
      toKind: "eval_result",
      toId: evalResultId,
      edgeType: "evaluated",
    });

    // ── Exercise ─────────────────────────────────────────────────────────────
    const { lessonId, amendmentId } = await createLessonAndAmendment({
      db,
      companyId,
      runId,
      evalResultId,
      verdict: "fail",
      summary: "The prompt produced an incorrect answer for the test scenario.",
      promptVersionId: promptVersion.id,
      promptId: prompt.id,
      // issueId omitted — service must resolve it via origin_run_id lookup.
    });

    // ── A: Row field assertions ──────────────────────────────────────────────
    const [lesson] = await db
      .select()
      .from(evalLessons)
      .where(eq(evalLessons.id, lessonId));

    expect(lesson).toBeDefined();
    expect(lesson.companyId).toBe(companyId);
    expect(lesson.runId).toBe(runId);
    expect(lesson.evalResultId).toBe(evalResultId);
    expect(lesson.verdict).toBe("fail");
    expect(lesson.issueId).toBe(issue.id); // resolved via origin_run_id

    const [amendment] = await db
      .select()
      .from(evalAmendments)
      .where(eq(evalAmendments.id, amendmentId));

    expect(amendment).toBeDefined();
    expect(amendment.lessonId).toBe(lessonId);
    expect(amendment.subjectKind).toBe("prompt");
    expect(amendment.subjectId).toBe(prompt.id);
    expect(amendment.status).toBe("proposed");
    expect(amendment.runId).toBe(runId);

    // ── B: Lineage edges emitted ──────────────────────────────────────────────
    const edges = await db
      .select()
      .from(lineageEdges)
      .where(
        sql`company_id = ${companyId}::uuid AND run_id = ${runId}::uuid AND edge_type IN ('caused_by', 'amends')`,
      );

    expect(edges).toHaveLength(2);

    const causedByEdge = edges.find((e) => e.edgeType === "caused_by");
    expect(causedByEdge).toMatchObject({
      companyId,
      fromKind: "eval_result",
      fromId: evalResultId,
      toKind: "eval_lesson",
      toId: lessonId,
      edgeType: "caused_by",
    });

    const amendsEdge = edges.find((e) => e.edgeType === "amends");
    expect(amendsEdge).toMatchObject({
      companyId,
      fromKind: "eval_lesson",
      fromId: lessonId,
      toKind: "eval_amendment",
      toId: amendmentId,
      edgeType: "amends",
    });

    // ── C: Full backward walk from amendment via recursive CTE ───────────────
    // Expected chain (backward): amendment ← lesson ← eval_result ← prompt_version
    const backward = await db.execute<{ from_kind: string; from_id: string; depth: number }>(
      sql.raw(`
        WITH RECURSIVE chain AS (
          SELECT from_kind, from_id, 0 AS depth
          FROM lineage_edges
          WHERE company_id = '${companyId}'
            AND to_kind = 'eval_amendment'
            AND to_id = '${amendmentId}'
          UNION ALL
          SELECT le.from_kind, le.from_id, c.depth + 1
          FROM lineage_edges le
          JOIN chain c ON le.company_id = '${companyId}'
            AND le.to_kind = c.from_kind
            AND le.to_id = c.from_id
          WHERE c.depth < 10
        )
        SELECT from_kind, from_id::text, depth FROM chain ORDER BY depth, from_kind
      `),
    );

    // depth 0: lesson is the direct predecessor of amendment
    expect(backward).toContainEqual({ from_kind: "eval_lesson", from_id: lessonId, depth: 0 });
    // depth 1: eval_result is the predecessor of lesson
    expect(backward).toContainEqual({ from_kind: "eval_result", from_id: evalResultId, depth: 1 });
    // depth 2: prompt_version is the predecessor of eval_result
    expect(backward).toContainEqual({ from_kind: "prompt_version", from_id: promptVersion.id, depth: 2 });

    // ── D: eval_lesson.run_id resolves to a heartbeat_run ────────────────────
    const [run] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, lesson.runId!));

    expect(run).toBeDefined();
    expect(run.id).toBe(runId);

    // ── E: An issue exists with origin_run_id = lesson.run_id ────────────────
    const [linkedIssue] = await db
      .select({ id: issues.id, originRunId: issues.originRunId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originRunId, lesson.runId!)));

    expect(linkedIssue).toBeDefined();
    expect(linkedIssue.originRunId).toBe(runId);
    expect(linkedIssue.id).toBe(issue.id);
  });
});
