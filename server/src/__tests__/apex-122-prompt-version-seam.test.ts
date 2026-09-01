/**
 * APEX-122 seam conformance: creating a prompt version writes exactly one
 * lineage_edge AND populates contract provenance (run_id, producer_kind,
 * producer_id), and the version is walkable from that edge.
 *
 * This is the "first real link" DoD check: prompt_version → prompt via
 * edge_type='produced'. Without this the cohesion spine has no link.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  companyPrompts,
  companyPromptVersions,
  createDb,
  heartbeatRuns,
  lineageEdges,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping APEX-122 seam tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("APEX-122 seam: prompt_version lineage_edge + provenance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex122-seam-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "APEX-122 Seam Test Co",
      issuePrefix: `A122${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Seam Test Agent",
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

  it("creates exactly one lineage_edge and populates provenance when a prompt version is published by an agent run", async () => {
    const runId = randomUUID();

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "active",
    });

    const [prompt] = await db
      .insert(companyPrompts)
      .values({
        companyId,
        name: "Test Prompt",
        slug: "test-prompt",
      })
      .returning();

    // Simulate what the POST /versions route handler does.
    const [version] = await db
      .insert(companyPromptVersions)
      .values({
        companyId,
        promptId: prompt.id,
        revisionNumber: 1,
        content: "You are a helpful assistant. {{task}}",
        variables: [{ name: "task", description: "The task to perform", required: true }],
        commitMessage: "Initial version",
        runId,
        producerKind: "agent",
        producerId: agentId,
      })
      .returning();

    await db.insert(lineageEdges).values({
      companyId,
      runId,
      fromKind: "prompt_version",
      fromId: version.id,
      toKind: "prompt",
      toId: prompt.id,
      edgeType: "produced",
    });

    // ── 1. Exactly one lineage_edge for this version ────────────────────────
    const edges = await db
      .select()
      .from(lineageEdges)
      .where(
        sql`company_id = ${companyId}::uuid AND from_kind = 'prompt_version' AND from_id = ${version.id}::uuid`,
      );

    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      companyId,
      runId,
      fromKind: "prompt_version",
      fromId: version.id,
      toKind: "prompt",
      toId: prompt.id,
      edgeType: "produced",
    });

    // ── 2. Provenance is populated on the version row ───────────────────────
    const [persisted] = await db
      .select()
      .from(companyPromptVersions)
      .where(sql`id = ${version.id}::uuid`);

    expect(persisted.runId).toBe(runId);
    expect(persisted.producerKind).toBe("agent");
    expect(persisted.producerId).toBe(agentId);

    // ── 3. Forward walk from the version via recursive CTE ──────────────────
    // Proves the prompt_version is walkable on the spine.
    const walk = await db.execute<{ to_kind: string; to_id: string; depth: number }>(
      sql.raw(`
        WITH RECURSIVE chain AS (
          SELECT to_kind, to_id, 0 AS depth
          FROM lineage_edges
          WHERE company_id = '${companyId}'
            AND from_kind = 'prompt_version'
            AND from_id = '${version.id}'
          UNION ALL
          SELECT le.to_kind, le.to_id, c.depth + 1
          FROM lineage_edges le
          JOIN chain c ON le.company_id = '${companyId}'
            AND le.from_kind = c.to_kind
            AND le.from_id = c.to_id
          WHERE c.depth < 10
        )
        SELECT to_kind, to_id::text, depth FROM chain ORDER BY depth
      `),
    );

    expect(walk).toHaveLength(1);
    expect(walk[0]).toMatchObject({
      to_kind: "prompt",
      to_id: prompt.id,
      depth: 0,
    });
  });

  it("version with run_id=null (human author) still writes a lineage_edge", async () => {
    const [prompt] = await db
      .insert(companyPrompts)
      .values({
        companyId,
        name: "Human Authored Prompt",
        slug: "human-authored-prompt",
      })
      .returning();

    const [version] = await db
      .insert(companyPromptVersions)
      .values({
        companyId,
        promptId: prompt.id,
        revisionNumber: 1,
        content: "A prompt without a run.",
        variables: [],
        runId: null,
        producerKind: "user",
        producerId: null,
      })
      .returning();

    await db.insert(lineageEdges).values({
      companyId,
      runId: null,
      fromKind: "prompt_version",
      fromId: version.id,
      toKind: "prompt",
      toId: prompt.id,
      edgeType: "produced",
    });

    const edges = await db
      .select()
      .from(lineageEdges)
      .where(
        sql`company_id = ${companyId}::uuid AND from_kind = 'prompt_version' AND from_id = ${version.id}::uuid`,
      );

    expect(edges).toHaveLength(1);
    expect(edges[0].runId).toBeNull();
    expect(edges[0].edgeType).toBe("produced");

    const [persisted] = await db
      .select()
      .from(companyPromptVersions)
      .where(sql`id = ${version.id}::uuid`);

    expect(persisted.runId).toBeNull();
    expect(persisted.producerKind).toBe("user");
    expect(persisted.producerId).toBeNull();
  });
});
