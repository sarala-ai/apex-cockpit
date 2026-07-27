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
import { summarizePenpotArchive, renderBoardSvgFromArchive } from "./penpot-archive.js";

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

// Every visit to the Design tab was re-paying ~2.4s of GitHub round-trips for
// a listing that changes rarely (measured; two gh calls per repo). Short TTL
// cache keyed by the repo set; the UI refetches on the same cadence.
const LISTING_TTL_MS = 45_000;
const listingCache = new Map<string, { at: number; data: DesignRepoListing[] }>();

export async function listCompanyDesignFiles(db: Db, companyId?: string): Promise<DesignRepoListing[]> {
  const repos = await companyGithubRepos(db, companyId);
  const key = [...repos].sort().join(",");
  const hit = listingCache.get(key);
  if (hit && Date.now() - hit.at < LISTING_TTL_MS) return hit.data;
  const data = await Promise.all(repos.map(listRepoDesignFiles));
  listingCache.set(key, { at: Date.now(), data });
  return data;
}

// Content-addressed summary cache: the expensive half of a document read is
// the blob download + archive parse + share-link mint. The cheap half (one
// contents-metadata call) yields the git sha — if it matches what we last
// parsed, the cached summary is by definition current.
const fileCache = new Map<string, { sha: string; content: DesignFileContent }>();

/** Raw archive bytes, sha-cached — lets the SVG route render a board offline
 *  from the committed file (no live Penpot involved). */
const rawCache = new Map<string, { sha: string; buf: Buffer }>();

export async function fetchDesignArchive(repo: string, path: string): Promise<Buffer | null> {
  if (!REPO_RE.test(repo) || !path.endsWith(".penpot") || path.includes("..")) return null;
  const meta = await run("gh", ["api", `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`], GH_TIMEOUT_MS);
  if (meta.status !== "ok") return null;
  const body = JSON.parse(meta.stdout) as { content?: string; sha?: string; size?: number };
  const key = `${repo}:${path}`;
  if (body.sha) {
    const hit = rawCache.get(key);
    if (hit && hit.sha === body.sha) return hit.buf;
  }
  let b64 = body.content ?? "";
  if (!b64.trim() && body.sha) {
    const blob = await run("gh", ["api", `repos/${repo}/git/blobs/${body.sha}`], GH_TIMEOUT_MS);
    if (blob.status !== "ok") return null;
    b64 = (JSON.parse(blob.stdout) as { content?: string }).content ?? "";
  }
  const buf = Buffer.from(b64, "base64");
  if (body.sha) rawCache.set(key, { sha: body.sha, buf });
  return buf;
}

export function renderArchiveBoard(buf: Buffer, boardId: string): string {
  return renderBoardSvgFromArchive(buf, boardId);
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
    const body = JSON.parse(res.stdout) as { content?: string; size?: number; encoding?: string; sha?: string };
    const cacheKey = `${repo}:${path}`;
    if (body.sha) {
      const cached = fileCache.get(cacheKey);
      if (cached && cached.sha === body.sha) return cached.content;
    }
    const size = typeof body.size === "number" ? body.size : null;
    if (size !== null && size > MAX_DOC_BYTES) {
      return { repo, path, document: null, parseError: `file too large (${size} bytes)`, sizeBytes: size };
    }
    let b64 = body.content ?? "";
    if (!b64.trim() && size !== null && size > 0 && body.sha) {
      // GitHub's contents API omits inline content for files over 1 MB
      // (encoding "none") — the blob API returns base64 up to 100 MB.
      // Found by clicking a 1.1 MB .penpot in the UI, not by curl.
      const blob = await run("gh", ["api", `repos/${repo}/git/blobs/${body.sha}`], GH_TIMEOUT_MS);
      if (blob.status !== "ok") {
        return { repo, path, document: null, parseError: "could not fetch blob (>1 MB path)", sizeBytes: size };
      }
      b64 = (JSON.parse(blob.stdout) as { content?: string }).content ?? "";
    }
    const raw = Buffer.from(b64, "base64");
    if (path.endsWith(".penpot")) {
      // Penpot export: summarize the ZIP-of-JSON (boards + manifest) rather
      // than dumping an unreadable binary.
      try {
        const summary = summarizePenpotArchive(raw);
        // The cockpit RENDERS designs itself (inline SVG from Penpot's
        // exporter + our own click map), so no iframe, no anonymous share
        // token, no Penpot session is involved in viewing. Editing is
        // deliberately elsewhere: governed via MCP / a ticket that updates
        // the file, or by hand in Penpot through this one escape hatch.
        const penpotBase = (process.env.APEX_PENPOT_URL ?? "http://localhost:9001").replace(/\/$/, "");
        const firstPage = summary.pages[0]?.id;
        const links = summary.fileId
          ? {
              penpotEditUrl: `${penpotBase}/#/workspace?file-id=${summary.fileId}${firstPage ? `&page-id=${firstPage}` : ""}`,
            }
          : {};
        const content: DesignFileContent = { repo, path, document: { ...summary, ...links }, parseError: null, sizeBytes: size };
        if (body.sha) fileCache.set(cacheKey, { sha: body.sha, content });
        return content;
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
      const content: DesignFileContent = { repo, path, document: JSON.parse(raw.toString("utf8")), parseError: null, sizeBytes: size };
      if (body.sha) fileCache.set(cacheKey, { sha: body.sha, content });
      return content;
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
