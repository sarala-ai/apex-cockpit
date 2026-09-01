/**
 * APEX-77 T5 — End-to-end: closing a blocker auto-dispatches the dependent
 * within one scheduler cycle.
 *
 * Validates the ENGINE GATE end-to-end over the existing wake+gate machinery.
 * The test does not change any engine code; it documents and verifies that the
 * behaviour already exists.
 */

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
    summary: "Dependency autodispatch test run.",
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
    `Skipping apex-77 dependency autodispatch tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("APEX-77 T5: closing a blocker auto-dispatches the dependent", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex77-autodispatch-");
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
      summary: "Dependency autodispatch test run.",
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

  it("closing blocker A auto-dispatches blocked B within one scheduler cycle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "AutoDispatch Co",
      issuePrefix: "APEX",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 5 } },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        identifier: "APEX-26",
        title: "Blocker A",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        identifier: "APEX-77",
        title: "Blocked B",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    // Attempt to wake blocked B — should be skipped (issue_dependencies_blocked).
    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    expect(blockedWake).toBeNull();

    // Verify the wakeup was skipped.
    const skippedWakeup = await waitFor(async () => {
      const wakeup = await db
        .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`)
        .then((rows) => rows[0] ?? null);
      return wakeup?.status === "skipped" && wakeup.reason === "issue_dependencies_blocked";
    });
    expect(skippedWakeup).toBe(true);

    // No heartbeat run should have been created for B yet.
    const runsBeforeResolution = await db
      .select()
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${blockedIssueId}`);
    expect(runsBeforeResolution).toHaveLength(0);

    const blockerCompletionTime = new Date();

    // Simulate blocker A completing: mark it done and fire issue_blockers_resolved.
    await db
      .update(issues)
      .set({ status: "done", updatedAt: blockerCompletionTime })
      .where(eq(issues.id, blockerIssueId));

    const resolvedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerIssueId },
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`,
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerIssueId,
      },
    });
    expect(resolvedWake).not.toBeNull();

    // Wait for a heartbeat_runs row for B to appear after A's completion.
    const newRunCreated = await waitFor(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status, createdAt: heartbeatRuns.createdAt })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${blockedIssueId}`)
        .then((rows) => rows[0] ?? null);
      return Boolean(
        run &&
        (run.status === "queued" || run.status === "running" || run.status === "succeeded") &&
        run.createdAt >= blockerCompletionTime,
      );
    });
    expect(newRunCreated).toBe(true);
  });
});
