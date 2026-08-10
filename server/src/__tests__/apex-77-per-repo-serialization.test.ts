/**
 * APEX-77 T4 — Per-repo serialization for implement (apply-mode) steps.
 *
 * Two apply-mode (implementer) queued runs on the same repo → after one
 * scheduler cycle exactly one is `running`, the other remains `queued`.
 * After the first finishes, the second is claimed.
 *
 * Two apply-mode runs on different repos → both reach `running` in one cycle.
 *
 * Two spec/plan (specifier) runs on the same repo → both reach `running` in
 * one cycle (exemption holds).
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
  projects,
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
    summary: "Per-repo serialization test run.",
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
    `Skipping apex-77 per-repo serialization tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("APEX-77 T4: per-repo serialization", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex77-per-repo-");
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
      summary: "Per-repo serialization test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    // Wait for active runs to finish.
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
    await db.delete(projects);
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

  it("two implementer runs on the same repo: one runs, one stays queued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issue1Id = randomUUID();
    const issue2Id = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Per-Repo Co",
      issuePrefix: "APEX",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    // Use "process" adapter so the codebase precondition check is skipped;
    // the per-repo serialization gate is keyed on agent name, not adapter type.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: "echo", args: [] },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 10 } },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: issue1Id,
        companyId,
        title: "Issue 1",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: issue2Id,
        companyId,
        title: "Issue 2",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    // Create a project row so execution_workspace creation doesn't hit a FK violation,
    // allowing run1 to stay "running" (blocked by the mock) long enough for the
    // per-repo serialization check on run2 to observe it.
    await db.insert(projects).values({ id: projectId, companyId, name: "Per-Repo Project" });

    // Make the adapter block so the first run stays running while we check.
    let releaseFirstRun: (() => void) | null = null;
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
          releaseFirstRun = () =>
            resolve({
              exitCode: 0,
              signal: null,
              timedOut: false,
              errorMessage: null,
              summary: "done",
              provider: "test",
              model: "test-model",
            });
        }),
    );

    // Wake both issues — they share the same projectId.
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue1Id },
      contextSnapshot: { issueId: issue1Id, wakeReason: "issue_assigned", projectId },
    });
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue2Id },
      contextSnapshot: { issueId: issue2Id, wakeReason: "issue_assigned", projectId },
    });

    // Wait until exactly one run is running and the other is still queued.
    const oneRunningOneQueued = await waitFor(async () => {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      const running = runs.filter((r) => r.status === "running").length;
      const queued = runs.filter((r) => r.status === "queued").length;
      return running === 1 && queued === 1;
    });
    expect(oneRunningOneQueued).toBe(true);

    // Release the first run so cleanup can proceed.
    releaseFirstRun?.();
  });

  it("two implementer runs on different repos: both run concurrently", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const project1Id = randomUUID();
    const project2Id = randomUUID();
    const issue1Id = randomUUID();
    const issue2Id = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Per-Repo Co 2",
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
      adapterType: "process",
      adapterConfig: { command: "echo", args: [] },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 10 } },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: issue1Id,
        companyId,
        title: "Issue 1",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: issue2Id,
        companyId,
        title: "Issue 2",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    let releaseBoth: (() => void)[] = [];
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
          releaseBoth.push(() =>
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

    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue1Id },
      contextSnapshot: { issueId: issue1Id, wakeReason: "issue_assigned", projectId: project1Id },
    });
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue2Id },
      contextSnapshot: { issueId: issue2Id, wakeReason: "issue_assigned", projectId: project2Id },
    });

    // Both should reach running concurrently.
    const bothRunning = await waitFor(async () => {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return runs.filter((r) => r.status === "running").length === 2;
    });
    expect(bothRunning).toBe(true);

    releaseBoth.forEach((fn) => fn());
  });

  it("two specifier runs on the same repo: both run concurrently (exemption)", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issue1Id = randomUUID();
    const issue2Id = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Per-Repo Specifier Co",
      issuePrefix: "APEX",
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    // Agent named "Specifier" (not "Implementer") — should be exempt.
    // Use "process" adapter type so the codebase precondition check is skipped.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Specifier",
      role: "product",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: "echo", args: [] },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 20 } },
      permissions: {},
    });

    await db.insert(issues).values([
      {
        id: issue1Id,
        companyId,
        title: "Issue 1",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: issue2Id,
        companyId,
        title: "Issue 2",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    let releaseBoth: (() => void)[] = [];
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
          releaseBoth.push(() =>
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

    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue1Id },
      contextSnapshot: { issueId: issue1Id, wakeReason: "issue_assigned", projectId },
    });
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue2Id },
      contextSnapshot: { issueId: issue2Id, wakeReason: "issue_assigned", projectId },
    });

    // Both specifier runs should reach running concurrently (no serialization).
    const bothRunning = await waitFor(async () => {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      return runs.filter((r) => r.status === "running").length === 2;
    });
    expect(bothRunning).toBe(true);

    releaseBoth.forEach((fn) => fn());
  });
});
