/**
 * GitHub projection module tests (mocked invoker, embedded Postgres for the
 * company-config/issue rows the projection reads and the mirror ref it
 * stores). The contract under test: per-company opt-in (silent no-op when
 * off), mirror creation at flow start only via the mirror-repo cascade (see
 * projection-repo-resolver.test.ts for the cascade's own unit tests — this
 * file covers the module wiring it into), origin-issue targeting for
 * ingested issues, lifecycle comments, close-owned-mirror-only, the mirror
 * label, and fire-and-forget failure isolation (an invoker throw NEVER
 * propagates).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues, projectWorkspaces, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { ApexInvoker } from "../apex/invoke.js";
import {
  apexIssueMarker,
  extractPullRequestUrl,
  githubFlowProjection,
  MIRROR_LABEL,
  noopFlowProjection,
} from "../apex/flow/github-projection.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres github-projection tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type InvokeCall = { server: string; tool: string; params: Record<string, unknown> };

function fakeInvoker(behavior: { failWith?: Error } = {}) {
  const calls: InvokeCall[] = [];
  const invoker: ApexInvoker = {
    async invoke(server, tool, params) {
      calls.push({ server, tool, params });
      if (behavior.failWith) throw behavior.failWith;
      if (tool === "create_issue") {
        return {
          status: "success",
          number: 77,
          url: `https://github.com/${params.repo}/issues/77`,
        } as never;
      }
      return { status: "success" } as never;
    },
  };
  return { invoker, calls };
}

describe("extractPullRequestUrl", () => {
  it("pulls the PR html_url out of a pr_exists acceptance evaluation", () => {
    expect(
      extractPullRequestUrl(
        "v1: run success + pr_exists verified (acme/repo#design/APE-7 → https://github.com/acme/repo/pull/12).",
      ),
    ).toBe("https://github.com/acme/repo/pull/12");
  });

  it("returns null when there is no URL (file_exists / run-success acceptance)", () => {
    expect(extractPullRequestUrl("v1: run success only")).toBeNull();
    expect(extractPullRequestUrl(null)).toBeNull();
    expect(extractPullRequestUrl(undefined)).toBeNull();
  });
});

describeEmbeddedPostgres("githubFlowProjection", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-projection-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(options: { enabled?: boolean; repo?: string | null } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Projection Co",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      githubProjectionEnabled: options.enabled ?? true,
      githubProjectionRepo: options.repo === undefined ? "acme/mirror" : options.repo,
    });
    return companyId;
  }

  async function seedProjectWithWorkspace(
    companyId: string,
    options: { repoUrl?: string | null } = {},
  ) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Widgets",
      status: "in_progress",
    });
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "git_remote",
      isPrimary: true,
      repoUrl: options.repoUrl ?? null,
    });
    return { projectId, projectWorkspaceId };
  }

  async function seedIssue(
    companyId: string,
    options: {
      originKind?: string;
      originId?: string | null;
      githubMirrorRef?: string | null;
      description?: string | null;
      agentBrief?: string | null;
      projectId?: string | null;
      projectWorkspaceId?: string | null;
    } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Fix the thing",
      identifier: "APE-9",
      description: options.description ?? "The thing is broken.",
      agentBrief: options.agentBrief ?? null,
      originKind: options.originKind ?? "manual",
      originId: options.originId ?? null,
      githubMirrorRef: options.githubMirrorRef ?? null,
      projectId: options.projectId ?? null,
      projectWorkspaceId: options.projectWorkspaceId ?? null,
    });
    return issueId;
  }

  async function mirrorRef(issueId: string) {
    const rows = await db
      .select({ githubMirrorRef: issues.githubMirrorRef })
      .from(issues)
      .where(eq(issues.id, issueId));
    return rows[0]?.githubMirrorRef ?? null;
  }

  it("is a silent no-op when the company has projection disabled", async () => {
    const companyId = await seedCompany({ enabled: false });
    const issueId = await seedIssue(companyId);
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowStarted({ issueId, flowName: "work" });
    await projection.gateOpened({ issueId, nodeId: "g", prompt: null, approvalId: randomUUID() });
    await projection.flowCompleted({ issueId, completedNodeId: "end" });

    expect(calls).toHaveLength(0);
    expect(await mirrorRef(issueId)).toBeNull();
  });

  it("flow start creates the mirror issue via the company fallback repo (no project binding), stamped with the mirror label", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowStarted({ issueId, flowName: "work" });

    expect(calls[0]).toMatchObject({ server: "github_repo", tool: "create_issue" });
    expect(calls[0].params.repo).toBe("acme/mirror");
    expect(calls[0].params.title).toBe("APE-9: Fix the thing");
    expect(calls[0].params.labels).toBe(MIRROR_LABEL);
    const body = String(calls[0].params.body);
    expect(body).toContain("The thing is broken.");
    expect(body).toContain(apexIssueMarker(issueId));
    expect(await mirrorRef(issueId)).toBe("acme/mirror#77");

    // Flow-started ledger comment lands on the freshly created mirror.
    expect(calls[1]).toMatchObject({
      server: "github_repo",
      tool: "comment_issue",
      params: { repo: "acme/mirror", number: 77 },
    });
    expect(String(calls[1].params.body)).toContain("Flow `work` started");
  });


  it("mirrors the human body only — the agent brief never reaches a public issue", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, {
      description: "The thing is broken.",
      agentBrief: 'apex run penpot update-file --file 7adae259 {"type":"add-obj","x":5190}',
    });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowStarted({ issueId, flowName: "work" });

    const body = String(calls[0].params.body);
    expect(body).toContain("The thing is broken.");
    expect(body).not.toContain("add-obj");
    expect(body).not.toContain("apex run penpot update-file");
    expect(body).not.toContain("7adae259");
  });

  it("flow start prefers the ticket's project workspace repo over the company fallback", async () => {
    const companyId = await seedCompany({ repo: "acme/company-fallback" });
    const { projectId, projectWorkspaceId } = await seedProjectWithWorkspace(companyId, {
      repoUrl: "https://github.com/acme/workspace-repo",
    });
    const issueId = await seedIssue(companyId, { projectId, projectWorkspaceId });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowStarted({ issueId, flowName: "work" });

    expect(calls[0]).toMatchObject({ server: "github_repo", tool: "create_issue" });
    expect(calls[0].params.repo).toBe("acme/workspace-repo");
    expect(await mirrorRef(issueId)).toBe("acme/workspace-repo#77");
  });

  it("flow start falls back to the project's PRIMARY workspace when the ticket has no explicit workspace binding", async () => {
    const companyId = await seedCompany({ repo: null });
    const { projectId } = await seedProjectWithWorkspace(companyId, {
      repoUrl: "git@github.com:acme/primary-repo.git",
    });
    const issueId = await seedIssue(companyId, { projectId });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowStarted({ issueId, flowName: "work" });

    expect(calls[0].params.repo).toBe("acme/primary-repo");
    expect(await mirrorRef(issueId)).toBe("acme/primary-repo#77");
  });

  it("falls through to the company fallback when the workspace's remote isn't GitHub", async () => {
    const companyId = await seedCompany({ repo: "acme/company-fallback" });
    const { projectId, projectWorkspaceId } = await seedProjectWithWorkspace(companyId, {
      repoUrl: "https://gitlab.com/acme/not-github",
    });
    const issueId = await seedIssue(companyId, { projectId, projectWorkspaceId });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowStarted({ issueId, flowName: "work" });

    expect(calls[0].params.repo).toBe("acme/company-fallback");
  });

  it("continues without the label when the labeled create_issue fails", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const calls: { tool: string; params: Record<string, unknown> }[] = [];
    let attempt = 0;
    const invoker: ApexInvoker = {
      async invoke(server, tool, params) {
        calls.push({ tool, params });
        if (tool === "create_issue") {
          attempt += 1;
          if (attempt === 1) throw new Error("labels field rejected");
          return { status: "success", number: 77, url: "https://github.com/acme/mirror/issues/77" } as never;
        }
        return { status: "success" } as never;
      },
    };
    const projection = githubFlowProjection(db, { invoker });

    await expect(projection.flowStarted({ issueId, flowName: "work" })).resolves.toBeUndefined();

    expect(calls.filter((c) => c.tool === "create_issue")).toHaveLength(2);
    expect(calls[0].params.labels).toBe(MIRROR_LABEL);
    expect(calls[1].params.labels).toBeUndefined();
    expect(await mirrorRef(issueId)).toBe("acme/mirror#77");
  });

  it("a github-origin issue targets its own origin issue — no duplicate mirror is created", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, {
      originKind: "plugin:github",
      originId: "acme/product#5",
    });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowStarted({ issueId, flowName: "work" });

    expect(calls.map((c) => c.tool)).toEqual(["comment_issue"]);
    expect(calls[0].params).toMatchObject({ repo: "acme/product", number: 5 });
    expect(await mirrorRef(issueId)).toBeNull();
  });

  it("cascade unresolved (no project binding, no company fallback) drops the mirror creation without throwing", async () => {
    const companyId = await seedCompany({ repo: null });
    const issueId = await seedIssue(companyId);
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowStarted({ issueId, flowName: "work" });

    expect(calls).toHaveLength(0);
    expect(await mirrorRef(issueId)).toBeNull();
  });

  it("non-start events without a mirror target are dropped (live-only, no retro-creation)", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.gateOpened({ issueId, nodeId: "g", prompt: "ok?", approvalId: randomUUID() });
    await projection.flowFailed({ issueId, nodeId: "g", errorType: "x", message: "y" });

    expect(calls).toHaveLength(0);
  });

  it("posts the commissioned comment with run id and the stamped permission profile", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { githubMirrorRef: "acme/mirror#41" });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "worker" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      permissionMode: "governed",
      permissionProfile: "restricted",
    });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.agentRunCommissioned({ issueId, nodeId: "build", runId });

    expect(calls).toHaveLength(1);
    expect(calls[0].params).toMatchObject({ repo: "acme/mirror", number: 41 });
    const body = String(calls[0].params.body);
    expect(body).toContain("Agent run commissioned");
    expect(body).toContain("`build`");
    expect(body).toContain(runId);
    expect(body).toContain("`restricted`");
    expect(body).toContain("governed");
  });

  it("omits the permission line when the run has no stamped profile", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { githubMirrorRef: "acme/mirror#41" });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.agentRunCommissioned({ issueId, nodeId: "build", runId: randomUUID() });

    expect(String(calls[0].params.body)).not.toContain("permission profile");
  });

  it("posts acceptance, gate-opened, and gate-decided ledger comments", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { githubMirrorRef: "acme/mirror#41" });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, {
      invoker,
      now: () => new Date("2026-08-01T12:00:00Z"),
    });

    const runId = randomUUID();
    await projection.acceptanceEvaluated({
      issueId,
      nodeId: "build",
      runId,
      ok: true,
      evaluation: "v1: run success only",
    });
    await projection.gateOpened({
      issueId,
      nodeId: "review",
      prompt: "Ship it?",
      approvalId: randomUUID(),
    });
    await projection.gateDecided({
      issueId,
      nodeId: "review",
      decision: "approve",
      decidedByUserId: "founder",
      approvalId: randomUUID(),
    });

    expect(calls.map((c) => c.tool)).toEqual(["comment_issue", "comment_issue", "comment_issue"]);
    expect(String(calls[0].params.body)).toContain("Acceptance passed");
    expect(String(calls[0].params.body)).toContain("v1: run success only");
    expect(String(calls[1].params.body)).toContain("Gate opened");
    expect(String(calls[1].params.body)).toContain("Ship it?");
    expect(String(calls[2].params.body)).toContain("`review` approved");
    expect(String(calls[2].params.body)).toContain("founder");
    expect(String(calls[2].params.body)).toContain("2026-08-01T12:00:00.000Z");
  });

  it("flow completion closes an OWNED mirror (state_reason completed) and carries the PR link", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { githubMirrorRef: "acme/mirror#41" });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowCompleted({
      issueId,
      completedNodeId: "merge",
      acceptanceEvaluation:
        "v1: run success + pr_exists verified (acme/repo#x → https://github.com/acme/repo/pull/9).",
    });

    expect(calls.map((c) => c.tool)).toEqual(["comment_issue", "close_issue"]);
    expect(String(calls[0].params.body)).toContain("https://github.com/acme/repo/pull/9");
    expect(calls[1].params).toMatchObject({
      repo: "acme/mirror",
      number: 41,
      state_reason: "completed",
    });
  });

  it("flow completion on a github-origin issue comments but NEVER closes the origin issue", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, {
      originKind: "plugin:github",
      originId: "acme/product#5",
    });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowCompleted({ issueId, completedNodeId: "merge" });

    expect(calls.map((c) => c.tool)).toEqual(["comment_issue"]);
  });

  it("posts the failure ledger comment and does not close anything", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { githubMirrorRef: "acme/mirror#41" });
    const { invoker, calls } = fakeInvoker();
    const projection = githubFlowProjection(db, { invoker });

    await projection.flowFailed({
      issueId,
      nodeId: "build",
      errorType: "agent_run_failed",
      message: "boom",
    });

    expect(calls.map((c) => c.tool)).toEqual(["comment_issue"]);
    const body = String(calls[0].params.body);
    expect(body).toContain("Flow FAILED");
    expect(body).toContain("[agent_run_failed] boom");
  });

  it("failure isolation: an invoker throw never propagates out of any hook", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, { githubMirrorRef: "acme/mirror#41" });
    const { invoker } = fakeInvoker({ failWith: new Error("gh exploded") });
    const projection = githubFlowProjection(db, { invoker });

    await expect(projection.flowStarted({ issueId, flowName: "work" })).resolves.toBeUndefined();
    await expect(
      projection.agentRunCommissioned({ issueId, nodeId: "n", runId: randomUUID() }),
    ).resolves.toBeUndefined();
    await expect(
      projection.acceptanceEvaluated({ issueId, nodeId: "n", runId: randomUUID(), ok: false, evaluation: "e" }),
    ).resolves.toBeUndefined();
    await expect(
      projection.gateOpened({ issueId, nodeId: "n", prompt: null, approvalId: randomUUID() }),
    ).resolves.toBeUndefined();
    await expect(
      projection.gateDecided({
        issueId,
        nodeId: "n",
        decision: "reject",
        decidedByUserId: "u",
        approvalId: randomUUID(),
      }),
    ).resolves.toBeUndefined();
    await expect(projection.flowCompleted({ issueId, completedNodeId: "n" })).resolves.toBeUndefined();
    await expect(
      projection.flowFailed({ issueId, nodeId: "n", errorType: "t", message: "m" }),
    ).resolves.toBeUndefined();
  });

  it("mirror-creation failure at flow start leaves no ref and never throws", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId);
    const { invoker } = fakeInvoker({ failWith: new Error("gh exploded") });
    const projection = githubFlowProjection(db, { invoker });

    await expect(projection.flowStarted({ issueId, flowName: "work" })).resolves.toBeUndefined();
    expect(await mirrorRef(issueId)).toBeNull();
  });

  it("noopFlowProjection resolves every hook", async () => {
    await expect(noopFlowProjection.flowStarted({ issueId: randomUUID(), flowName: "x" })).resolves.toBeUndefined();
    await expect(
      noopFlowProjection.flowCompleted({ issueId: randomUUID(), completedNodeId: null }),
    ).resolves.toBeUndefined();
  });
});
