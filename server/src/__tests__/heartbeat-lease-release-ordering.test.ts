import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { heartbeatService } from "../services/heartbeat.ts";

// The finalization chain after a run goes terminal is long (issue summary,
// comment policy, promotion, recovery). The lease must already be gone by the
// time the first of those steps starts, so the order of these markers is the
// property under test, not the steps themselves.
const finalizationOrder = vi.hoisted(() => [] as string[]);

vi.mock("../services/issue-continuation-summary.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-continuation-summary.ts")>(
    "../services/issue-continuation-summary.ts",
  );
  return {
    ...actual,
    refreshIssueContinuationSummary: vi.fn(async (input: { run: { id: string } }) => {
      finalizationOrder.push(`continuation_summary:${input.run.id}`);
      return null;
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const FAILING_ADAPTER = "lease_release_ordering_failing_adapter";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres lease release ordering tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat environment lease release ordering", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-lease-release-ordering-");
    db = createDb(tempDb.connectionString);
    registerServerAdapter({
      type: FAILING_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "adapter exploded",
        errorCode: "adapter_failed",
      }),
      testEnvironment: async () => ({
        adapterType: FAILING_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    finalizationOrder.length = 0;
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "environment_leases",
        "environments",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "issues",
        "company_skills",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    unregisterServerAdapter(FAILING_ADAPTER);
    await tempDb?.cleanup();
  });

  it("releases the environment lease before continuation summary and recovery work on adapter failure", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FailingAgent",
      role: "engineer",
      status: "idle",
      adapterType: FAILING_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Run that fails",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const runtime = environmentRuntimeService(db);
    const releaseRunLeases = runtime.releaseRunLeases;
    let releaseCalls = 0;
    runtime.releaseRunLeases = async (...args) => {
      releaseCalls += 1;
      const released = await releaseRunLeases(...args);
      if (released.length > 0) finalizationOrder.push(`lease_release:${args[0]}`);
      return released;
    };

    const heartbeat = heartbeatService(db, { environmentRuntime: runtime });
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "manual",
      contextSnapshot: { issueId, skipIssueComment: true },
    });
    expect(run).not.toBeNull();
    const runId = run!.id;

    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(runId);
      expect(latest?.status).toBe("failed");
      expect(finalizationOrder).toContain(`continuation_summary:${runId}`);
    }, { timeout: 10_000 });

    const releaseIndex = finalizationOrder.indexOf(`lease_release:${runId}`);
    expect(releaseIndex).toBe(0);
    expect(finalizationOrder.indexOf(`continuation_summary:${runId}`)).toBeGreaterThan(releaseIndex);
    // The safety-net release sees no active lease, so the marker is recorded once per run.
    expect(finalizationOrder.filter((step) => step === `lease_release:${runId}`)).toHaveLength(1);

    // Failure recovery may dispatch follow-up runs for the same agent; the
    // table cleanup below must not race their finalization tails. Every run
    // calls the release twice (terminal write + `finally` safety net), so the
    // count settling at twice the run count marks the system as quiescent.
    await vi.waitFor(async () => {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      expect(runs.every((row) => row.status !== "queued" && row.status !== "running")).toBe(true);
      expect(releaseCalls).toBe(runs.length * 2);
    }, { timeout: 15_000, interval: 100 });

    const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    expect(leases).toHaveLength(1);
    expect(leases[0]?.status).toBe("failed");
    expect(leases[0]?.releasedAt).not.toBeNull();
  }, 30_000);
});
