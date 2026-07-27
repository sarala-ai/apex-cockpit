/**
 * Design-as-code discovery — finds .op files across a company's bound GitHub
 * repos and fetches individual documents, via the `gh` CLI (deterministic
 * core, already-authed; same pattern as the CI-runs card).
 *
 * Failure-isolated per repo: one repo erroring (private, deleted, unauthed)
 * reports on its own listing entry and never takes down the rest. Errors are
 * classified and surfaced, never swallowed.
 */
import type { Db } from "@paperclipai/db";
import type { DesignRepoListing, DesignFileEntry, DesignFileContent } from "@paperclipai/shared";
import { companyGithubRepos } from "../observe/company-projects.js";
import { run } from "../apex/exec.js";

const GH_TIMEOUT_MS = 15_000;
/** Refuse to fetch documents beyond this — .op files are JSON design docs,
 *  not asset dumps; anything this large is a mistake worth surfacing. */
const MAX_DOC_BYTES = 4 * 1024 * 1024;

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function classifyGhFailure(stderr: string): string {
  if (/auth|login|token|not logged/i.test(stderr)) {
    return "gh is not authenticated — run `gh auth login`.";
  }
  if (/404|Not Found/i.test(stderr)) {
    return "repo not found (or no access with the current gh identity).";
  }
  return `gh failed: ${stderr.trim().slice(0, 200)}`;
}

interface TreeEntry {
  path?: string;
  type?: string;
  size?: number;
  sha?: string;
}

async function listRepoDesignFiles(repo: string): Promise<DesignRepoListing> {
  if (!REPO_RE.test(repo)) {
    return { repo, files: [], truncated: false, error: "invalid repo binding (expected owner/name)" };
  }
  // Resolve the default branch first (robust against non-main defaults), then
  // one recursive tree read. Two gh calls per repo, both read-only.
  const meta = await run("gh", ["api", `repos/${repo}`, "--jq", ".default_branch"], GH_TIMEOUT_MS);
  if (meta.status === "missing") {
    return { repo, files: [], truncated: false, error: "GitHub CLI (gh) is not installed or not on PATH." };
  }
  if (meta.status === "failed") {
    return { repo, files: [], truncated: false, error: classifyGhFailure(meta.stderr) };
  }
  const branch = meta.stdout.trim();
  if (!branch) {
    return { repo, files: [], truncated: false, error: "could not resolve default branch" };
  }

  const tree = await run(
    "gh",
    ["api", `repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`],
    GH_TIMEOUT_MS,
  );
  if (tree.status !== "ok") {
    const stderr = tree.status === "failed" ? tree.stderr : "gh unavailable";
    return { repo, files: [], truncated: false, error: classifyGhFailure(stderr) };
  }

  let parsed: { tree?: TreeEntry[]; truncated?: boolean };
  try {
    parsed = JSON.parse(tree.stdout);
  } catch {
    return { repo, files: [], truncated: false, error: "could not parse gh tree output" };
  }

  const files: DesignFileEntry[] = (parsed.tree ?? [])
    .filter((e): e is TreeEntry & { path: string } => e.type === "blob" && typeof e.path === "string" && e.path.endsWith(".op"))
    .map((e) => ({
      repo,
      path: e.path,
      name: e.path.split("/").pop()!.replace(/\.op$/, ""),
      url: `https://github.com/${repo}/blob/${branch}/${e.path}`,
      sizeBytes: typeof e.size === "number" ? e.size : null,
      sha: e.sha ?? null,
    }));

  return { repo, files, truncated: parsed.truncated === true, error: null };
}

export async function listCompanyDesignFiles(db: Db, companyId?: string): Promise<DesignRepoListing[]> {
  const repos = await companyGithubRepos(db, companyId);
  return Promise.all(repos.map(listRepoDesignFiles));
}

export async function fetchDesignFile(repo: string, path: string): Promise<DesignFileContent | null> {
  if (!REPO_RE.test(repo) || !path.endsWith(".op") || path.includes("..")) return null;
  // contents API returns base64; decode locally. Size-guarded.
  const res = await run(
    "gh",
    ["api", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`],
    GH_TIMEOUT_MS,
  );
  if (res.status !== "ok") return null;
  try {
    const body = JSON.parse(res.stdout) as { content?: string; size?: number; encoding?: string };
    const size = typeof body.size === "number" ? body.size : null;
    if (size !== null && size > MAX_DOC_BYTES) {
      return { repo, path, document: null, parseError: `file too large (${size} bytes)`, sizeBytes: size };
    }
    const raw = Buffer.from(body.content ?? "", "base64").toString("utf8");
    try {
      return { repo, path, document: JSON.parse(raw), parseError: null, sizeBytes: size };
    } catch (e) {
      return {
        repo,
        path,
        document: null,
        parseError: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
        sizeBytes: size,
      };
    }
  } catch {
    return null;
  }
}
