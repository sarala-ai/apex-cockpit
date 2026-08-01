/**
 * Mirror-repo resolution for the GitHub projection (see github-projection.ts).
 *
 * Founder correction: GitHub issues are repo-scoped by design — a single
 * company-wide `githubProjectionRepo` is the wrong seam. The ticket already
 * knows which repo its work lands in via its project workspace, so mirror
 * targeting is an ordered cascade:
 *
 *   1. The ticket's project workspace repo — `issues.projectWorkspaceId` if
 *      set, else the project's PRIMARY workspace via `issues.projectId`.
 *   2. Company fallback (`companies.githubProjectionRepo`) — for tickets with
 *      no repo-bearing project binding.
 *   3. None — projection is skipped for that flow (classified log, caller's
 *      responsibility — this module stays logger-free so it is trivially
 *      unit-testable: every path returns a classified result, never throws).
 *
 * `project_workspaces.repoUrl` can be an https URL, an ssh remote, or already
 * "owner/name" — `normalizeGithubRepoUrl` collapses all three to "owner/name"
 * and returns null for non-GitHub hosts (gitlab.com, bitbucket.org, etc.).
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces } from "@paperclipai/db";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** Normalizes an https URL, an ssh remote, or a bare "owner/name" string to
 *  "owner/name". Returns null when the value isn't a recognizable GitHub
 *  remote (wrong host, or too malformed to parse) — never throws. */
export function normalizeGithubRepoUrl(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();
  if (!trimmed) return null;

  // Already "owner/name" (no scheme, no ssh user@host).
  if (/^[^/\s@:]+\/[^/\s]+$/.test(trimmed)) {
    return stripDotGit(trimmed);
  }

  // scp-style ssh remote: git@github.com:owner/name.git, or ssh://git@github.com/owner/name.git
  const scpMatch = /^(?:ssh:\/\/)?[^@/\s]+@([^:/\s]+)[:/](.+)$/.exec(trimmed);
  if (scpMatch) {
    const [, host, path] = scpMatch;
    if (!GITHUB_HOSTS.has(host.toLowerCase())) return null;
    const ownerName = stripDotGit(path.replace(/^\/+/, "").replace(/\/+$/, ""));
    return isOwnerName(ownerName) ? ownerName : null;
  }

  // https/http/git+ssh URL.
  try {
    const url = new URL(trimmed);
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
    const path = stripDotGit(url.pathname.replace(/^\/+/, "").replace(/\/+$/, ""));
    const parts = path.split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    const ownerName = `${parts[0]}/${parts[1]}`;
    return isOwnerName(ownerName) ? ownerName : null;
  } catch {
    return null;
  }
}

function stripDotGit(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function isOwnerName(value: string): boolean {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

export type MirrorRepoResolution =
  | { repo: string; source: "ticket_workspace" | "company_fallback"; notes: string[] }
  | { repo: null; reason: "projection_repo_unresolved"; notes: string[] };

export type MirrorRepoResolutionContext = {
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  companyFallbackRepo: string | null;
};

/** Loads the repoUrl of the ticket's bound workspace (explicit
 *  projectWorkspaceId first, else the project's primary workspace). Returns
 *  null when there is no repo-bearing binding to try — a normal, unlogged
 *  cascade step, not an error. */
async function loadTicketWorkspaceRepoUrl(
  db: Db,
  ctx: MirrorRepoResolutionContext,
): Promise<string | null> {
  if (ctx.projectWorkspaceId) {
    const row = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, ctx.companyId),
          eq(projectWorkspaces.id, ctx.projectWorkspaceId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row?.repoUrl ?? null;
  }
  if (ctx.projectId) {
    const row = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(
        and(
          eq(projectWorkspaces.companyId, ctx.companyId),
          eq(projectWorkspaces.projectId, ctx.projectId),
          eq(projectWorkspaces.isPrimary, true),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return row?.repoUrl ?? null;
  }
  return null;
}

/** The one resolver the projection module calls at flow start. Never throws —
 *  a miss along the way is a classified note (`notes`, e.g.
 *  "projection_repo_not_github") and the cascade keeps going; a total miss is
 *  `{ repo: null, reason: "projection_repo_unresolved" }` for the caller to
 *  log. */
export async function resolveMirrorRepo(
  db: Db,
  ctx: MirrorRepoResolutionContext,
): Promise<MirrorRepoResolution> {
  const notes: string[] = [];

  const workspaceRepoUrl = await loadTicketWorkspaceRepoUrl(db, ctx);
  if (workspaceRepoUrl) {
    const normalized = normalizeGithubRepoUrl(workspaceRepoUrl);
    if (normalized) return { repo: normalized, source: "ticket_workspace", notes };
    notes.push("projection_repo_not_github");
  }

  if (ctx.companyFallbackRepo) {
    const normalized = normalizeGithubRepoUrl(ctx.companyFallbackRepo);
    if (normalized) return { repo: normalized, source: "company_fallback", notes };
    notes.push("projection_repo_not_github");
  }

  return { repo: null, reason: "projection_repo_unresolved", notes };
}
