import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const execFile = promisify(execFileCallback);

/**
 * The reproduction, run through the real dispatch path rather than the guard's
 * own signature: a queued run is resumed, and what is asserted is what an
 * operator would see afterwards — the run refused, the ticket carrying a
 * comment that says why, and the ticket NOT left claiming to be in progress.
 *
 * These assertions fail if the guard is removed from `executeRun`: without it
 * the run proceeds past the precondition point and finalizes with a different
 * error code and no configuration_incomplete escalation, so neither the
 * `blocked` status nor the refusal comment appears.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dispatch-precondition tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("dispatch preconditions (end to end)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-dispatch-preconditions-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  const temporaryCheckouts: string[] = [];

  afterEach(async () => {
    while (temporaryCheckouts.length > 0) {
      await fs.rm(temporaryCheckouts.pop()!, { recursive: true, force: true }).catch(() => undefined);
    }
    // TRUNCATE ... CASCADE rather than an ordered delete: a dispatch refusal
    // writes runtime state, activity and recovery rows across many tables, and
    // enumerating them here would silently rot as the escalation path grows.
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedDispatch(options: { adapterConfig: Record<string, unknown> }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Cockpit",
      status: "active",
      issuePrefix: `APEX${Math.floor(Math.random() * 100000)}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Implementer",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: options.adapterConfig,
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true },
      },
      permissions: {},
    });

    // The reported shape: a task created through the UI with `Project: None`,
    // assigned to a roster agent, already claiming to be in progress.
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "APEX-12",
      title: "Refuse dispatch without preconditions",
      status: "in_progress",
      assigneeAgentId: agentId,
      projectId: null,
      projectWorkspaceId: null,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "queued",
      responsibleUserId: "operator-1",
      contextSnapshot: { issueId, responsibleUserId: "operator-1" },
    });

    return { companyId, agentId, issueId, runId };
  }

  /** Give the task a real codebase: a project whose workspace points at a git
   *  checkout on disk, which is what the "no codebase" precondition is absent. */
  async function bindCodebase(input: { companyId: string; issueId: string }) {
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dispatch-precondition-repo-"));
    await execFile("git", ["init"], { cwd });
    temporaryCheckouts.push(cwd);

    await db.insert(projects).values({
      id: projectId,
      companyId: input.companyId,
      name: "Cockpit",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: workspaceId,
      companyId: input.companyId,
      projectId,
      name: "primary",
      sourceType: "local_path",
      cwd,
      isPrimary: true,
    });
    await db
      .update(issues)
      .set({ projectId, projectWorkspaceId: workspaceId })
      .where(eq(issues.id, input.issueId));

    return { projectId, workspaceId, cwd };
  }

  async function readRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .then((rows) => rows.find((row) => row.id === runId) ?? null);
  }

  async function runAndSettle(runId: string) {
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    // `resumeQueuedRuns` dispatches without awaiting the execution, so poll the
    // run itself to a terminal status rather than the in-process execution set,
    // which may not be populated yet at the instant we start waiting.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const current = await readRun(runId);
      if (current && current.status !== "queued" && current.status !== "running") return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return readRun(runId);
  }

  async function waitForIssueStatus(issueId: string, expected: string) {
    const deadline = Date.now() + 30_000;
    let status: string | null = null;
    while (Date.now() < deadline) {
      status = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0]?.status ?? null);
      if (status === expected) return status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return status;
  }

  async function waitForCommentContaining(issueId: string, needle: string) {
    const deadline = Date.now() + 30_000;
    let joined = "";
    while (Date.now() < deadline) {
      joined = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId))
        .then((rows) => rows.map((row) => row.body ?? "").join("\n---\n"));
      if (joined.includes(needle)) return joined;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return joined;
  }

  it("refuses a task with no project, and says so on the ticket", async () => {
    // A grant that WRITES: since the precondition is scoped by
    // agentWritesRepositories, a read-only grant no longer trips it (that is
    // the fix), so the refusal case must be an agent that would change code.
    const { issueId, runId } = await seedDispatch({
      adapterConfig: { dangerouslySkipPermissions: false, allowedTools: "Read Grep Edit Write Bash" },
    });

    const run = await runAndSettle(runId);

    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("configuration_incomplete");
    expect(run?.error).toContain("has no codebase");
    expect(run?.error).toContain(
      "assign this task to a project with a repository, or set a repo on the project",
    );

    // Not left in a lying state. The escalation runs after the run row is
    // finalized, so wait for the ticket rather than reading it at the instant
    // the run turned terminal.
    const issueStatus = await waitForIssueStatus(issueId, "blocked");
    expect(issueStatus).toBe("blocked");

    // Visible on the ticket, not only in a log line.
    const commentText = await waitForCommentContaining(issueId, "no codebase was bound to it");
    expect(commentText).toContain("no codebase was bound to it");
    expect(commentText).toContain("Recovery action:");
  }, 120_000);

  it("dispatches a read-only agent with no project past the codebase precondition", async () => {
    // The APEX-15 shape: an agent whose effective grant carries no write verb
    // (Product Assistant's read-repos profile) assigned a ticket with no
    // project. It reads history, it was never asked to change code, so the
    // no-codebase refusal must not fire. Run through the real path so this
    // also proves the effective adapter config carries the grant at the guard.
    const { issueId, runId } = await seedDispatch({
      adapterConfig: {
        dangerouslySkipPermissions: false,
        allowedTools: "Read Grep Glob Bash(git log:*) Bash(gh pr view:*)",
      },
    });

    const run = await runAndSettle(runId);

    expect(run?.errorCode).not.toBe("configuration_incomplete");
    expect(run?.error ?? "").not.toContain("has no codebase");
    // And the ticket was not escalated to blocked by a precondition refusal.
    const issueStatus = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status ?? null);
    expect(issueStatus).not.toBe("blocked");
  }, 120_000);

  it("refuses a run whose config carries no permission decision, even with a codebase", async () => {
    // This is the routine/route-triggered shape: nothing on this path consults
    // derivePermissionPolicy, so before the guard the run inherited the
    // claude-local `dangerouslySkipPermissions: true` default silently.
    const { companyId, issueId, runId } = await seedDispatch({ adapterConfig: {} });
    await bindCodebase({ companyId, issueId });

    const run = await runAndSettle(runId);

    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("configuration_incomplete");
    expect(run?.error).toContain("has no permission decision");
    expect(run?.error).toContain("dangerouslySkipPermissions");

    expect(await waitForIssueStatus(issueId, "blocked")).toBe("blocked");
    expect(
      await waitForCommentContaining(issueId, "no explicit permission decision"),
    ).toContain("no explicit permission decision was in its run config");
  }, 120_000);

  it("dispatches past both preconditions when a codebase and a decision are present", async () => {
    // The guard must refuse the unusable case WITHOUT refusing the usable one.
    // This run gets past the preconditions and fails later, on the adapter —
    // a different code, and no configuration_incomplete escalation.
    const { companyId, issueId, runId } = await seedDispatch({
      adapterConfig: { dangerouslySkipPermissions: false, allowedTools: "Read,Grep" },
    });
    await bindCodebase({ companyId, issueId });

    const run = await runAndSettle(runId);

    expect(run?.errorCode).not.toBe("configuration_incomplete");
    expect(run?.error ?? "").not.toContain("has no codebase");
    expect(run?.error ?? "").not.toContain("has no permission decision");
  }, 120_000);
});
