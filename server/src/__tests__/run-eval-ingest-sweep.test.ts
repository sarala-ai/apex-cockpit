import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { runEvalIngestSweep } from "../observe/run-eval-ingest-sweep.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("run eval ingest sweep", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("run-eval-ingest");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    const [agent] = await db
      .insert(agents)
      .values({ companyId, name: "Implementer", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {} })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "Canary", status: "in_progress", identifier: "T-1", issueNumber: 1 } as never)
      .returning();
    return { companyId, agentId: agent!.id, issueId: issue!.id };
  }

  async function seedRun(input: { companyId: string; agentId: string; issueId?: string; status?: string; finished?: boolean }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "succeeded",
      startedAt: new Date("2026-09-03T04:19:23Z"),
      finishedAt: input.finished === false ? null : new Date("2026-09-03T04:22:56Z"),
      contextSnapshot: input.issueId ? { issueId: input.issueId } : null,
    } as never);
    return id;
  }

  it("ingests finished runs oldest-first with the issue spine and marks them; failures leave them pending", async () => {
    const { companyId, agentId, issueId } = await seed();
    const done = await seedRun({ companyId, agentId, issueId });
    const running = await seedRun({ companyId, agentId, status: "running", finished: false });
    const sent: Array<{ runId: string; body: unknown }> = [];
    const sweep = runEvalIngestSweep(db, {
      ingest: { ingestRunTrace: async (p) => { sent.push(p); return true; } },
      readLog: async () => "",
      log: () => {},
    });

    const first = await sweep.sweep();
    expect(first).toEqual({ ingested: 1, skipped: 1, stoppedEarly: false });
    expect(sent.map((s) => s.runId)).toEqual([done]);
    const attrs = (sent[0]!.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> })
      .resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    const byKey = Object.fromEntries(attrs.map((a) => [a.key, Object.values(a.value)[0]]));
    expect(byKey["apex.issue.id"]).toBe(issueId);
    expect(byKey["apex.agent.kind"]).toBe("coding");
    expect(byKey["apex.agent.name"]).toBe("Implementer");

    const [row] = await db.select({ at: heartbeatRuns.evalIngestedAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, done));
    expect(row!.at).not.toBeNull();
    const [still] = await db.select({ at: heartbeatRuns.evalIngestedAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, running));
    expect(still!.at).toBeNull();

    // A second pass finds nothing new.
    expect((await sweep.sweep()).ingested).toBe(0);
  });

  it("stops the tick and leaves runs pending when apex-eval does not accept", async () => {
    const { companyId, agentId } = await seed();
    const a = await seedRun({ companyId, agentId, status: "failed" });
    const sweep = runEvalIngestSweep(db, {
      ingest: { ingestRunTrace: async () => false },
      readLog: async () => { throw new Error("no log"); },
      log: () => {},
    });
    expect(await sweep.sweep()).toEqual({ ingested: 0, skipped: 0, stoppedEarly: true });
    const [row] = await db.select({ at: heartbeatRuns.evalIngestedAt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, a));
    expect(row!.at).toBeNull();
  });
});
