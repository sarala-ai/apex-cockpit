import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, issues, lineageEdges, routineRuns, routines } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping lineage DAG walk tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("lineage_edges: walkable DAG via recursive CTE", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lineage-dag-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Lineage Test Co",
      issuePrefix: `LT${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("walks a 3-node chain forward (issue → run → lesson) and backward via recursive CTE", async () => {
    const issueId = randomUUID();
    const runId = randomUUID();
    const lessonId = randomUUID();

    // Insert the two-edge chain: issue --spawned--> run --produced--> eval_lesson
    await db.insert(lineageEdges).values([
      {
        companyId,
        fromKind: "issue",
        fromId: issueId,
        toKind: "heartbeat_run",
        toId: runId,
        edgeType: "spawned",
      },
      {
        companyId,
        fromKind: "heartbeat_run",
        fromId: runId,
        toKind: "eval_lesson",
        toId: lessonId,
        edgeType: "produced",
      },
    ]);

    // Forward walk: start at issue, collect all descendants.
    const forward = await db.execute<{ to_kind: string; to_id: string; depth: number }>(
      sql.raw(`
        WITH RECURSIVE chain AS (
          SELECT to_kind, to_id, 0 AS depth
          FROM lineage_edges
          WHERE company_id = '${companyId}'
            AND from_kind = 'issue'
            AND from_id = '${issueId}'
          UNION ALL
          SELECT le.to_kind, le.to_id, c.depth + 1
          FROM lineage_edges le
          JOIN chain c ON le.company_id = '${companyId}'
            AND le.from_kind = c.to_kind
            AND le.from_id = c.to_id
          WHERE c.depth < 10
        )
        SELECT to_kind, to_id::text, depth FROM chain ORDER BY depth
      `)
    );

    expect(forward).toHaveLength(2);
    expect(forward[0]).toMatchObject({ to_kind: "heartbeat_run", to_id: runId, depth: 0 });
    expect(forward[1]).toMatchObject({ to_kind: "eval_lesson", to_id: lessonId, depth: 1 });

    // Backward walk: start at lesson, collect all ancestors.
    const backward = await db.execute<{ from_kind: string; from_id: string; depth: number }>(
      sql.raw(`
        WITH RECURSIVE chain AS (
          SELECT from_kind, from_id, 0 AS depth
          FROM lineage_edges
          WHERE company_id = '${companyId}'
            AND to_kind = 'eval_lesson'
            AND to_id = '${lessonId}'
          UNION ALL
          SELECT le.from_kind, le.from_id, c.depth + 1
          FROM lineage_edges le
          JOIN chain c ON le.company_id = '${companyId}'
            AND le.to_kind = c.from_kind
            AND le.to_id = c.from_id
          WHERE c.depth < 10
        )
        SELECT from_kind, from_id::text, depth FROM chain ORDER BY depth
      `)
    );

    expect(backward).toHaveLength(2);
    expect(backward[0]).toMatchObject({ from_kind: "heartbeat_run", from_id: runId, depth: 0 });
    expect(backward[1]).toMatchObject({ from_kind: "issue", from_id: issueId, depth: 1 });
  });

  it("routine_execution issue: inserting with a routine_runs.id as origin_run_id succeeds (no FK error)", async () => {
    // APEX-146 regression guard: origin_run_id is polymorphic — routine_execution
    // issues store a routine_runs.id, NOT a heartbeat_runs.id. Adding an FK to
    // heartbeat_runs broke routine execution with a 23503 constraint violation.
    // This test verifies the FK is absent and the insert succeeds.
    const [routine] = await db.insert(routines).values({
      companyId,
      title: "Lineage Test Routine",
      status: "active",
      priority: "medium",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      originKind: "manual",
    }).returning();

    const [routineRun] = await db.insert(routineRuns).values({
      companyId,
      routineId: routine.id,
      source: "scheduled",
      status: "received",
    }).returning();

    // This insert must NOT throw 23503 — routine_runs.id is not a heartbeat_runs.id.
    const [createdIssue] = await db.insert(issues).values({
      companyId,
      title: "Routine execution issue",
      status: "todo",
      originKind: "routine_execution",
      originRunId: routineRun.id,
      originRunKind: "routine_run",
    }).returning();

    expect(createdIssue.originRunId).toBe(routineRun.id);
    expect(createdIssue.originRunKind).toBe("routine_run");
  });
});
