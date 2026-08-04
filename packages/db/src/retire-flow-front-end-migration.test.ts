/**
 * 0173 — retiring the flow front-end.
 *
 * The migration has to do something no schema change usually does: take live
 * rows written by one execution host and hand them to another. Two properties
 * are load-bearing and are asserted here rather than assumed.
 *
 * 1. A flow case whose definition HAS a pipeline counterpart is migrated IN
 *    PLACE — same id, same version, same issue links, same event history. A
 *    case is the audit record of a piece of work; recreating it would look
 *    identical on a board and be a different row underneath.
 *
 * 2. A flow case whose definition has NO counterpart makes the migration
 *    REFUSE. Neither of the two easy alternatives is honest: writing a
 *    fabricated `pipeline_id` puts a fiction into the authoritative pointer
 *    (the failure 0168 already declined to commit), and deleting the row makes
 *    a migration the actor that decided someone's work should stop existing.
 *    A refusal with the case ids in the message is the only outcome a person
 *    can act on.
 *
 * Method follows issue-comment-derived-attribution-migration.test.ts: apply
 * everything, un-apply 0173 by deleting its recorded hash, restore the schema
 * as it stood before it, seed, then re-apply.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION = "0173_retire_flow_front_end.sql";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function freshDatabase(): Promise<ReturnType<typeof postgres>> {
  const temp = await startEmbeddedPostgresTestDatabase("paperclip-retire-flows-");
  cleanups.push(temp.cleanup);
  await applyPendingMigrations(temp.connectionString);
  const sql = postgres(temp.connectionString, { max: 1 });
  cleanups.push(async () => {
    await sql.end();
  });
  return sql;
}

/** Put the schema back the way 0167 left it, and make 0173 pending again. */
async function rewindToPreMigrationState(sql: ReturnType<typeof postgres>): Promise<void> {
  const hash = createHash("sha256")
    .update(await fs.promises.readFile(new URL(`./migrations/${MIGRATION}`, import.meta.url), "utf8"))
    .digest("hex");
  await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${hash}`;

  await sql.unsafe(`
    alter table "issues"
      add column if not exists "flow_name" text,
      add column if not exists "flow_node_id" text,
      add column if not exists "flow_status" text,
      add column if not exists "flow_run_id" uuid,
      add column if not exists "flow_started_at" timestamptz,
      add column if not exists "flow_advanced_at" timestamptz,
      add column if not exists "flow_executor_agent_id" uuid;

    alter table "pipeline_cases" alter column "pipeline_id" drop not null;
    alter table "pipeline_cases" alter column "stage_id" drop not null;

    alter table "pipeline_cases" drop constraint if exists "pipeline_cases_definition_kind_check";
    alter table "pipeline_cases"
      add constraint "pipeline_cases_definition_kind_check"
      check ("definition_kind" in ('pipeline', 'flow'));

    alter table "pipeline_cases" drop constraint if exists "pipeline_cases_definition_shape_check";
    alter table "pipeline_cases"
      add constraint "pipeline_cases_definition_shape_check"
      check (
        ("definition_kind" = 'pipeline' and "pipeline_id" is not null and "stage_id" is not null)
        or ("definition_kind" = 'flow' and "pipeline_id" is null and "stage_id" is null
            and "definition_ref" is not null and "step_key" is not null)
      );
  `);
}

type Seed = { companyId: string; pipelineId: string; stageId: string };

async function seedCompanyWithFeaturePipeline(sql: ReturnType<typeof postgres>): Promise<Seed> {
  const companyId = randomUUID();
  const pipelineId = randomUUID();
  const stageId = randomUUID();
  await sql`
    INSERT INTO "companies" ("id", "name", "issue_prefix")
    VALUES (${companyId}, 'Retire Flows', 'RF')
  `;
  await sql`
    INSERT INTO "pipelines" ("id", "company_id", "key", "name")
    VALUES (${pipelineId}, ${companyId}, 'feature', 'Feature')
  `;
  await sql`
    INSERT INTO "pipeline_stages" ("id", "pipeline_id", "key", "name", "kind", "position")
    VALUES (${stageId}, ${pipelineId}, 'spec', 'Spec', 'working', 0)
  `;
  return { companyId, pipelineId, stageId };
}

async function insertFlowCase(
  sql: ReturnType<typeof postgres>,
  input: { companyId: string; caseKey: string; definitionRef: string; stepKey: string },
): Promise<string> {
  const caseId = randomUUID();
  await sql`
    INSERT INTO "pipeline_cases"
      ("id", "company_id", "pipeline_id", "stage_id", "definition_kind", "definition_ref",
       "step_key", "case_key", "title", "version")
    VALUES
      (${caseId}, ${input.companyId}, null, null, 'flow', ${input.definitionRef},
       ${input.stepKey}, ${input.caseKey}, 'A ticket mid-flight', 4)
  `;
  return caseId;
}

describeEmbeddedPostgres("0173 retires the flow front-end", () => {
  it("migrates a mappable flow case in place, keeping its identity and version", async () => {
    const sql = await freshDatabase();
    await rewindToPreMigrationState(sql);
    const seed = await seedCompanyWithFeaturePipeline(sql);
    const caseId = await insertFlowCase(sql, {
      companyId: seed.companyId,
      caseKey: "RF-1",
      definitionRef: "feature",
      stepKey: "spec",
    });

    await applyPendingMigrations(buildConnectionString(sql));

    const [row] = await sql`
      SELECT "id", "pipeline_id", "stage_id", "definition_kind", "definition_ref", "step_key", "version"
      FROM "pipeline_cases" WHERE "id" = ${caseId}
    `;
    expect(row).toMatchObject({
      id: caseId,
      pipeline_id: seed.pipelineId,
      stage_id: seed.stageId,
      definition_kind: "pipeline",
      definition_ref: seed.pipelineId,
      step_key: "spec",
      // Untouched: this is the same case, not a replacement for it.
      version: 4,
    });
  });

  it("refuses rather than fabricating a pointer when a flow has no pipeline counterpart", async () => {
    const sql = await freshDatabase();
    await rewindToPreMigrationState(sql);
    const seed = await seedCompanyWithFeaturePipeline(sql);
    const strandedId = await insertFlowCase(sql, {
      companyId: seed.companyId,
      caseKey: "RF-2",
      // No pipeline is keyed `legacy-flow`, so nothing maps.
      definitionRef: "legacy-flow",
      stepKey: "spec",
    });

    await expect(applyPendingMigrations(buildConnectionString(sql))).rejects.toThrow(
      /flow-defined case/i,
    );

    // The refusal must leave the row exactly as it was — a migration that
    // half-applies is worse than one that declines.
    const [row] = await sql`
      SELECT "definition_kind", "pipeline_id" FROM "pipeline_cases" WHERE "id" = ${strandedId}
    `;
    expect(row).toMatchObject({ definition_kind: "flow", pipeline_id: null });
  });

  it("refuses when the flow maps to a pipeline but the step names no stage", async () => {
    const sql = await freshDatabase();
    await rewindToPreMigrationState(sql);
    const seed = await seedCompanyWithFeaturePipeline(sql);
    await insertFlowCase(sql, {
      companyId: seed.companyId,
      caseKey: "RF-3",
      definitionRef: "feature",
      // The pipeline exists; this node id is not one of its stage keys.
      stepKey: "a-node-that-became-nothing",
    });

    await expect(applyPendingMigrations(buildConnectionString(sql))).rejects.toThrow(
      /flow-defined case/i,
    );
  });

  it("drops the flow mirror columns and restores the case shape", async () => {
    const sql = await freshDatabase();

    const flowColumns = await sql`
      SELECT "column_name" FROM information_schema.columns
      WHERE "table_name" = 'issues' AND "column_name" LIKE 'flow%'
    `;
    expect(flowColumns).toHaveLength(0);

    const nullability = await sql`
      SELECT "column_name", "is_nullable" FROM information_schema.columns
      WHERE "table_name" = 'pipeline_cases' AND "column_name" IN ('pipeline_id', 'stage_id')
      ORDER BY "column_name"
    `;
    expect(nullability).toEqual([
      { column_name: "pipeline_id", is_nullable: "NO" },
      { column_name: "stage_id", is_nullable: "NO" },
    ]);

    const shapeCheck = await sql`
      SELECT "conname" FROM pg_constraint
      WHERE "conrelid" = 'pipeline_cases'::regclass
        AND "conname" = 'pipeline_cases_definition_shape_check'
    `;
    expect(shapeCheck).toHaveLength(0);

    const flowIndex = await sql`
      SELECT "indexname" FROM pg_indexes WHERE "indexname" = 'pipeline_cases_flow_case_key_uq'
    `;
    expect(flowIndex).toHaveLength(0);
  });
});

/** The connection string behind an open `postgres` client. */
function buildConnectionString(sql: ReturnType<typeof postgres>): string {
  const options = sql.options as unknown as {
    user: string;
    pass: string;
    host: string[];
    port: number[];
    database: string;
  };
  return `postgres://${options.user}:${options.pass}@${options.host[0]}:${options.port[0]}/${options.database}`;
}
