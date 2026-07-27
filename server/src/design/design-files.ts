/**
 * Design-as-code discovery — finds .penpot exports (and legacy .op files)
 * across a company's bound GitHub repos and fetches individual documents, via
 * the `gh` CLI (deterministic core, already-authed; same pattern as the
 * CI-runs card).
 *
 * Failure-isolated per repo: one repo erroring (private, deleted, unauthed)
 * reports on its own listing entry and never takes down the rest. Errors are
 * classified and surfaced, never swallowed.
 */
import type { Db } from "@paperclipai/db";
import type { DesignRepoListing, DesignFileEntry, DesignFileContent } from "@paperclipai/shared";
import { companyGithubRepos } from "../observe/company-projects.js";
import { run } from "../apex/exec.js";
import { summarizePenpotArchive } from "./penpot-archive.js";

const GH_TIMEOUT_MS = 15_000;
/** Refuse to fetch documents beyond this — design docs are JSON (or small
 *  ZIP-of-JSON .penpot exports), not asset dumps; anything this large is a
 *  mistake worth surfacing. */
const MAX_DOC_BYTES = 4 * 1024 * 1024;

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
/** .penpot = Penpot export (ZIP-of-JSON, canonical); .op = legacy seed
 *  format, still listed so old files surface instead of vanishing. */
const DESIGN_EXT_RE = /\.(penpot|op)$/;

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
    .filter((e): e is TreeEntry & { path: string } => e.type === "blob" && typeof e.path === "string" && DESIGN_EXT_RE.test(e.path))
    .map((e) => ({
      repo,
      path: e.path,
      name: e.path.split("/").pop()!.replace(DESIGN_EXT_RE, ""),
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
  if (!REPO_RE.test(repo) || !DESIGN_EXT_RE.test(path) || path.includes("..")) return null;
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
    const raw = Buffer.from(body.content ?? "", "base64");
    if (path.endsWith(".penpot")) {
      // Penpot export: summarize the ZIP-of-JSON (boards + manifest) rather
      // than dumping an unreadable binary.
      try {
        const summary = summarizePenpotArchive(raw);
        // Deep links into the live Penpot instance the export came from
        // (manifest carries the file id — same id in the working store).
        // APEX_PENPOT_URL: the compose design-profile frontend by default.
        const penpotBase = (process.env.APEX_PENPOT_URL ?? "http://localhost:9001").replace(/\/$/, "");
        const firstPage = summary.pages[0]?.id;
        const links = summary.fileId
          ? {
              penpotEditUrl: `${penpotBase}/#/workspace?file-id=${summary.fileId}${firstPage ? `&page-id=${firstPage}` : ""}`,
              penpotViewUrl: firstPage
                ? `${penpotBase}/#/view?file-id=${summary.fileId}&page-id=${firstPage}`
                : null,
            }
          : {};
        return { repo, path, document: { ...summary, ...links }, parseError: null, sizeBytes: size };
      } catch (e) {
        return {
          repo,
          path,
          document: null,
          parseError: `not a readable Penpot export: ${e instanceof Error ? e.message : String(e)}`,
          sizeBytes: size,
        };
      }
    }
    try {
      return { repo, path, document: JSON.parse(raw.toString("utf8")), parseError: null, sizeBytes: size };
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
