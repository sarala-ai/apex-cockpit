/**
 * Promotion/close reflection back to GitHub (work-loop doctrine — see
 * docs/architecture/work-loop.md's "Reflection outward" column). GitHub is
 * intake plus a mirror, never a second writer after promotion: once a fork
 * issue leaves `backlog` the cockpit owns the pen, and this module only ever
 * writes a label/comment/close back to GitHub, never a status field the
 * ingest job would read back in.
 *
 * Best-effort throughout: a reflection failure is a classified log line,
 * never something that blocks or rolls back the issue transition that
 * triggered it — the cockpit's transition already committed by the time this
 * runs.
 */
import type { TicketSource } from "./ticket-source.js";
import { GitHubIssuesSource } from "./ticket-source.js";

const LOG_PREFIX = "[github-issue-reflect]";

export const GITHUB_PROMOTED_LABEL = "apex:promoted";
export const GITHUB_DONE_LABEL = "apex:done";

/** Parses a `plugin:github` originId ("owner/repo#123") back into repo + issue number. */
export function parseGithubOriginId(originId: string): { repo: string; number: number } | null {
  const idx = originId.lastIndexOf("#");
  if (idx <= 0 || idx === originId.length - 1) return null;
  const repo = originId.slice(0, idx);
  const numberPart = originId.slice(idx + 1);
  if (!repo.includes("/")) return null;
  const number = Number(numberPart);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { repo, number };
}

export type GithubReflectAction = "promoted" | "closed" | "skipped" | "failed";

export type GithubReflectResult = {
  action: GithubReflectAction;
  detail: string;
};

type ReflectableIssue = {
  originKind?: string | null;
  originId?: string | null;
  status: string;
  identifier?: string | null;
};

/**
 * Called after an issue update commits. Reflects a promotion (status leaves
 * `backlog`) or a terminal close (`done`/`cancelled`) back to the bound
 * GitHub issue, when `previous`/`next` describe a `plugin:github`-origin
 * issue and the status actually changed. No-op (returns `skipped`) for
 * anything else — including a `plugin:github` issue whose status didn't
 * change, or one moving between two non-backlog, non-terminal statuses
 * (already promoted, nothing new to reflect).
 */
export async function reflectGithubIssueTransition(
  previous: ReflectableIssue,
  next: ReflectableIssue,
  opts: { source?: TicketSource & Pick<GitHubIssuesSource, "addLabel" | "comment" | "close">; log?: (line: string) => void } = {},
): Promise<GithubReflectResult> {
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} ${line}`));
  if (previous.originKind !== "plugin:github" || !previous.originId) {
    return { action: "skipped", detail: "not a plugin:github-origin issue" };
  }
  if (previous.status === next.status) {
    return { action: "skipped", detail: "status did not change" };
  }
  const parsed = parseGithubOriginId(previous.originId);
  if (!parsed) {
    return { action: "skipped", detail: `unparseable originId: ${previous.originId}` };
  }
  const source = opts.source ?? new GitHubIssuesSource();
  const identifier = next.identifier ?? previous.identifier ?? next.originId ?? previous.originId;

  try {
    if ((next.status === "done" || next.status === "cancelled") && previous.status === "backlog") {
      // Finding 5d (adversarial architecture review): during the Statement
      // phase (still `backlog`) GitHub holds the pen — the mirror was never
      // promoted, so a cockpit-side cancel/done here is local triage only.
      // Closing the upstream issue would be a second writer clobbering
      // GitHub's own close/reopen decisions on an issue the cockpit never
      // took ownership of.
      log(`repo=${parsed.repo} issue=${parsed.number} skipped: backlog-origin issue closed locally, not reflected upstream`);
      return { action: "skipped", detail: "backlog mirror cancelled/done locally — no upstream write" };
    }

    if (next.status === "done" || next.status === "cancelled") {
      const labelRes = await source.addLabel(parsed.repo, parsed.number, GITHUB_DONE_LABEL);
      if (!labelRes.ok) {
        log(`repo=${parsed.repo} issue=${parsed.number} addLabel(${GITHUB_DONE_LABEL}) failed: ${labelRes.message}`);
      }
      const closeRes = await source.close(parsed.repo, parsed.number);
      if (!closeRes.ok) {
        log(`repo=${parsed.repo} issue=${parsed.number} close failed: ${closeRes.message}`);
        return { action: "failed", detail: closeRes.message };
      }
      log(`repo=${parsed.repo} issue=${parsed.number} closed (${next.status} in APEX)`);
      return { action: "closed", detail: `closed on GitHub (${next.status} in APEX)` };
    }

    if (previous.status === "backlog") {
      const labelRes = await source.addLabel(parsed.repo, parsed.number, GITHUB_PROMOTED_LABEL);
      if (!labelRes.ok) {
        log(`repo=${parsed.repo} issue=${parsed.number} addLabel(${GITHUB_PROMOTED_LABEL}) failed: ${labelRes.message}`);
      }
      const commentRes = await source.comment(parsed.repo, parsed.number, `Promoted to ${identifier} in APEX.`);
      if (!commentRes.ok) {
        log(`repo=${parsed.repo} issue=${parsed.number} comment failed: ${commentRes.message}`);
        return { action: "failed", detail: commentRes.message };
      }
      log(`repo=${parsed.repo} issue=${parsed.number} reflected promotion to ${identifier}`);
      return { action: "promoted", detail: `commented + labeled promotion to ${identifier}` };
    }

    return { action: "skipped", detail: "not a backlog->promoted or ->terminal transition" };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log(`repo=${parsed.repo} issue=${parsed.number} reflection threw: ${detail}`);
    return { action: "failed", detail };
  }
}
