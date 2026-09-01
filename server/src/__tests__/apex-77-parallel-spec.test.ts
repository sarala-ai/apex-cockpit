/**
 * APEX-77 T6 — Observation test: two unblocked tickets at the spec stage
 * assigned to the same Specifier agent run concurrently.
 *
 * This test verifies that the engine's existing claim logic does NOT serialize
 * Specifier runs. It is a read-only observation — no engine code is changed.
 * Passing this test confirms the Specifier exemption is in effect.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Parallel spec test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping apex-77 parallel-spec tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

describeEmbeddedPostgres("APEX-77 T6: parallel spec steps run concurrently", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex77-parallel-spec-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Parallel spec test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    for (let i = 0; i < 100; i++) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      if (!runs.some((r) => r.status === "queued" || r.status === "running")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companies);
        });
        break;
      } catch {
        if (attempt === 4) throw new Error("Failed to delete companies");
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("two unblocked tickets promoted to spec stage both dispatch to Specifier concurrently", async () => {
    const companyId = randomUUID();
    const specifierAgentId = randomUUID();
    const projectId = randomUUID();
    const issue1Id = randomUUID();
    const issue2Id = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Parallel Spec Co",
      issuePrefix: "APEX",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    // Specifier agent — must NOT be serialized by per-repo logic.
    // Use "process" adapter type so the codebase precondition check is skipped;
    // the mock replaces the adapter execute regardless of type.
    await db.insert(agents).values({
      id: specifierAgentId,
      companyId,
      name: "Specifier",
      role: "product",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: "echo", args: [] },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 20 } },
      permissions: {},
    });

    // Two independent issues — neither blocked by anything.
    await db.insert(issues).values([
      {
        id: issue1Id,
        companyId,
        title: "Promoted ticket 1 (spec stage)",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: specifierAgentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: issue2Id,
        companyId,
        title: "Promoted ticket 2 (spec stage)",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: specifierAgentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    // Block the adapter so we can observe overlapping running status.
    let releaseRuns: Array<() => void> = [];
    mockAdapterExecute.mockImplementation(
      () =>
        new Promise<{
          exitCode: number;
          signal: null;
          timedOut: boolean;
          errorMessage: null;
          summary: string;
          provider: string;
          model: string;
        }>((resolve) => {
          releaseRuns.push(() =>
            resolve({
              exitCode: 0,
              signal: null,
              timedOut: false,
              errorMessage: null,
              summary: "done",
              provider: "test",
              model: "test-model",
            }),
          );
        }),
    );

    // Wake both tickets as if spec stage was just promoted for each.
    await heartbeat.wakeup(specifierAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue1Id },
      contextSnapshot: { issueId: issue1Id, wakeReason: "issue_assigned", projectId },
    });
    await heartbeat.wakeup(specifierAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue2Id },
      contextSnapshot: { issueId: issue2Id, wakeReason: "issue_assigned", projectId },
    });

    // Both should reach `running` at the same time — Specifier is NOT serialized.
    const bothRunningConcurrently = await waitFor(async () => {
      const runs = await db
        .select({ status: heartbeatRuns.status, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, specifierAgentId));
      const runningCount = runs.filter((r) => r.status === "running").length;
      return runningCount === 2;
    });
    expect(bothRunningConcurrently).toBe(true);

    // Verify NO run stayed queued while the other was running (that would indicate
    // the per-repo serializer incorrectly fired for the Specifier).
    const anyQueued = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, specifierAgentId))
      .then((rows) => rows.some((r) => r.status === "queued"));
    expect(anyQueued).toBe(false);

    releaseRuns.forEach((fn) => fn());
  });
});
