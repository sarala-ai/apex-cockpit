/**
 * Mirror-repo resolution cascade (see
 * ../apex/flow/projection-repo-resolver.ts): the ticket's project workspace
 * repo first (explicit binding, else the project's primary workspace), the
 * company fallback second, none third. Also covers URL normalization
 * (https/ssh/bare owner-name, non-GitHub hosts) in isolation from the DB.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, projectWorkspaces, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { normalizeGithubRepoUrl, resolveMirrorRepo } from "../apex/flow/projection-repo-resolver.js";

describe("normalizeGithubRepoUrl", () => {
  it("passes through a bare owner/name", () => {
    expect(normalizeGithubRepoUrl("acme/widgets")).toBe("acme/widgets");
  });

  it("strips a trailing .git from a bare owner/name", () => {
    expect(normalizeGithubRepoUrl("acme/widgets.git")).toBe("acme/widgets");
  });

  it("normalizes an https GitHub URL", () => {
    expect(normalizeGithubRepoUrl("https://github.com/acme/widgets")).toBe("acme/widgets");
    expect(normalizeGithubRepoUrl("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(normalizeGithubRepoUrl("https://github.com/acme/widgets/")).toBe("acme/widgets");
  });

  it("normalizes an scp-style ssh remote", () => {
    expect(normalizeGithubRepoUrl("git@github.com:acme/widgets.git")).toBe("acme/widgets");
  });

  it("normalizes an ssh:// URL remote", () => {
    expect(normalizeGithubRepoUrl("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
  });

  it("returns null for a non-GitHub host (gitlab, bitbucket, self-hosted)", () => {
    expect(normalizeGithubRepoUrl("https://gitlab.com/acme/widgets")).toBeNull();
    expect(normalizeGithubRepoUrl("git@gitlab.com:acme/widgets.git")).toBeNull();
    expect(normalizeGithubRepoUrl("https://git.internal.example/acme/widgets")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(normalizeGithubRepoUrl("")).toBeNull();
    expect(normalizeGithubRepoUrl("not a repo at all")).toBeNull();
    expect(normalizeGithubRepoUrl("https://github.com/onlyowner")).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres projection-repo-resolver tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("resolveMirrorRepo", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-projection-repo-resolver-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(fallbackRepo: string | null = null) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Resolver Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      githubProjectionRepo: fallbackRepo,
    });
    return companyId;
  }

  async function seedProject(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Widgets",
      status: "in_progress",
    });
    return projectId;
  }

  async function seedWorkspace(
    companyId: string,
    projectId: string,
    options: { isPrimary?: boolean; repoUrl?: string | null } = {},
  ) {
    const id = randomUUID();
    await db.insert(projectWorkspaces).values({
      id,
      companyId,
      projectId,
      name: options.isPrimary ? "Primary" : "Secondary",
      sourceType: "git_remote",
      isPrimary: options.isPrimary ?? false,
      repoUrl: options.repoUrl ?? null,
    });
    return id;
  }

  it("resolves the ticket's explicit workspace-bound repo (no project-primary fallback needed)", async () => {
    const companyId = await seedCompany("acme/company-fallback");
    const projectId = await seedProject(companyId);
    // A non-primary workspace still wins when the ticket is bound to it directly.
    await seedWorkspace(companyId, projectId, { isPrimary: true, repoUrl: "acme/primary-repo" });
    const boundWorkspaceId = await seedWorkspace(companyId, projectId, {
      isPrimary: false,
      repoUrl: "https://github.com/acme/bound-repo",
    });

    const resolution = await resolveMirrorRepo(db, {
      companyId,
      projectId,
      projectWorkspaceId: boundWorkspaceId,
      companyFallbackRepo: "acme/company-fallback",
    });

    expect(resolution).toMatchObject({ repo: "acme/bound-repo", source: "ticket_workspace" });
  });

  it("falls back to the project's PRIMARY workspace when the ticket has no explicit workspace binding", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    await seedWorkspace(companyId, projectId, { isPrimary: false, repoUrl: "acme/not-primary" });
    await seedWorkspace(companyId, projectId, { isPrimary: true, repoUrl: "git@github.com:acme/primary.git" });

    const resolution = await resolveMirrorRepo(db, {
      companyId,
      projectId,
      projectWorkspaceId: null,
      companyFallbackRepo: null,
    });

    expect(resolution).toMatchObject({ repo: "acme/primary", source: "ticket_workspace" });
  });

  it("falls through to the company fallback when the bound workspace's remote isn't GitHub", async () => {
    const companyId = await seedCompany("acme/fallback-repo");
    const projectId = await seedProject(companyId);
    const workspaceId = await seedWorkspace(companyId, projectId, {
      isPrimary: true,
      repoUrl: "https://gitlab.com/acme/not-github",
    });

    const resolution = await resolveMirrorRepo(db, {
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      companyFallbackRepo: "acme/fallback-repo",
    });

    expect(resolution).toMatchObject({ repo: "acme/fallback-repo", source: "company_fallback" });
    expect((resolution as { notes: string[] }).notes).toContain("projection_repo_not_github");
  });

  it("uses the company fallback when the ticket has no repo-bearing project binding at all", async () => {
    const companyId = await seedCompany("acme/fallback-only");

    const resolution = await resolveMirrorRepo(db, {
      companyId,
      projectId: null,
      projectWorkspaceId: null,
      companyFallbackRepo: "acme/fallback-only",
    });

    expect(resolution).toMatchObject({ repo: "acme/fallback-only", source: "company_fallback" });
  });

  it("resolves to unresolved when nothing in the cascade produces a repo", async () => {
    const companyId = await seedCompany();
    const projectId = await seedProject(companyId);
    await seedWorkspace(companyId, projectId, { isPrimary: true, repoUrl: null });

    const resolution = await resolveMirrorRepo(db, {
      companyId,
      projectId,
      projectWorkspaceId: null,
      companyFallbackRepo: null,
    });

    expect(resolution).toMatchObject({ repo: null, reason: "projection_repo_unresolved" });
  });

  it("resolves to unresolved when both the workspace remote and the fallback are non-GitHub", async () => {
    const companyId = await seedCompany("https://gitlab.com/acme/fallback");
    const projectId = await seedProject(companyId);
    const workspaceId = await seedWorkspace(companyId, projectId, {
      isPrimary: true,
      repoUrl: "https://gitlab.com/acme/workspace",
    });

    const resolution = await resolveMirrorRepo(db, {
      companyId,
      projectId,
      projectWorkspaceId: workspaceId,
      companyFallbackRepo: "https://gitlab.com/acme/fallback",
    });

    expect(resolution).toMatchObject({ repo: null, reason: "projection_repo_unresolved" });
    expect((resolution as { notes: string[] }).notes).toEqual([
      "projection_repo_not_github",
      "projection_repo_not_github",
    ]);
  });
});
