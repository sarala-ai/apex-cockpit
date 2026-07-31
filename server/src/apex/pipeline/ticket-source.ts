/**
 * TicketSource seam (spec 002). GitHub Issues is the source of truth this
 * milestone; repo/SpecKit files and Linear slot behind the same interface later.
 */

import { err, ok, type Result } from '../errors.js';
import { run } from '../exec.js';
import type { Ticket } from './types.js';

/** `gh issue list` page size. Finding 2 (adversarial architecture review):
 *  the previous 30-issue cap meant any repo with a backlog bigger than that
 *  had its 31st-and-beyond open issues silently absent from `list()` —
 *  and the ingest job's closed-on-GitHub sweep (see github-issue-ingest.ts)
 *  used to treat "absent from list()" as "closed", mass-cancelling live
 *  backlog. Raised well above any repo we bind today; `truncated` on the
 *  `list()` result surfaces it if a repo ever grows past this. */
export const GITHUB_ISSUE_LIST_LIMIT = 200;

export interface TicketSource {
  /** List candidate tickets (open issues) for a repo. `truncated` is true
   *  when the page came back exactly at the list limit — a signal (not a
   *  guarantee) that more open issues exist upstream than were returned. */
  list(repo: string): Promise<Result<Ticket[]> & { source: string; truncated?: boolean }>;
  /** Fetch one ticket by number. */
  get(repo: string, number: number): Promise<Result<Ticket> & { source: string }>;
  /** Reflect pipeline progress back to the SoT (label/comment). Best-effort. */
  updateStatus(repo: string, number: number, status: string): Promise<Result<true>>;
}

interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels?: Array<{ name: string }>;
}

function toTicket(repo: string, i: GhIssue): Ticket {
  return {
    id: `${repo}#${i.number}`,
    source: 'github',
    repo,
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    url: i.url,
    status: i.state,
    labels: i.labels?.map((l) => l.name),
  };
}

/** Maps a `gh` failure to a classified, human-actionable error. */
function classifyGh(res: Extract<Awaited<ReturnType<typeof run>>, { status: 'missing' | 'failed' }>) {
  if (res.status === 'missing') {
    return err('tool-missing', 'GitHub CLI (gh) is not installed or not on PATH.');
  }
  const unauth = /auth|login|token|not logged/i.test(res.stderr);
  return unauth
    ? err('tool-unauth', 'gh is not authenticated — run `gh auth login`.')
    : err('tool-failed', `gh failed: ${res.stderr.trim().slice(0, 200)}`);
}

export class GitHubIssuesSource implements TicketSource {
  async list(repo: string): Promise<Result<Ticket[]> & { source: string; truncated?: boolean }> {
    if (!repo) return { ...err('empty', 'Pass a repo (owner/name).'), source: 'no-repo' };
    const res = await run('gh', [
      'issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(GITHUB_ISSUE_LIST_LIMIT),
      '--json', 'number,title,body,url,state',
    ]);
    if (res.status !== 'ok') return { ...classifyGh(res), source: 'unavailable' };
    try {
      const issues = JSON.parse(res.stdout) as GhIssue[];
      // Truncation is never silent: a full page means there may be more open
      // issues upstream than we fetched. The caller (github-issue-ingest.ts)
      // logs this as a classified warning rather than treating the missing
      // tail as "closed".
      const truncated = issues.length >= GITHUB_ISSUE_LIST_LIMIT;
      return { ...ok(issues.map((i) => toTicket(repo, i))), source: 'gh', truncated };
    } catch {
      return { ...err('parse-failed', 'Could not parse gh issue JSON.'), source: 'unavailable' };
    }
  }

  async get(repo: string, number: number): Promise<Result<Ticket> & { source: string }> {
    const res = await run('gh', [
      'issue', 'view', String(number), '--repo', repo,
      '--json', 'number,title,body,url,state,labels',
    ]);
    if (res.status !== 'ok') return { ...classifyGh(res), source: 'unavailable' };
    try {
      return { ...ok(toTicket(repo, JSON.parse(res.stdout) as GhIssue)), source: 'gh' };
    } catch {
      return { ...err('parse-failed', 'Could not parse gh issue JSON.'), source: 'unavailable' };
    }
  }

  async updateStatus(repo: string, number: number, status: string): Promise<Result<true>> {
    // Best-effort: reflect stage as an issue comment. Non-fatal if it fails.
    const res = await run('gh', [
      'issue', 'comment', String(number), '--repo', repo,
      '--body', `apex-tower: ${status}`,
    ]);
    return res.status === 'ok' ? ok(true) : classifyGh(res);
  }

  /** Post an arbitrary comment (used by the promotion/close reflection —
   *  distinct from `updateStatus`'s fixed "apex-tower: {status}" body). */
  async comment(repo: string, number: number, body: string): Promise<Result<true>> {
    const res = await run('gh', [
      'issue', 'comment', String(number), '--repo', repo,
      '--body', body,
    ]);
    return res.status === 'ok' ? ok(true) : classifyGh(res);
  }

  /** Add a label, creating it first if `gh` reports it doesn't exist yet
   *  (repos bound to apex-tower won't have `apex:promoted`/`apex:done`
   *  pre-created). Best-effort, like the rest of this reflection surface. */
  async addLabel(repo: string, number: number, label: string): Promise<Result<true>> {
    const res = await run('gh', ['issue', 'edit', String(number), '--repo', repo, '--add-label', label]);
    if (res.status === 'ok') return ok(true);
    const missingLabel = res.status === 'failed' && /not found|does not exist/i.test(res.stderr);
    if (missingLabel) {
      const created = await run('gh', ['label', 'create', label, '--repo', repo, '--color', 'ededed', '--force']);
      if (created.status !== 'ok') return classifyGh(created);
      const retry = await run('gh', ['issue', 'edit', String(number), '--repo', repo, '--add-label', label]);
      return retry.status === 'ok' ? ok(true) : classifyGh(retry);
    }
    return classifyGh(res);
  }

  async close(repo: string, number: number): Promise<Result<true>> {
    const res = await run('gh', ['issue', 'close', String(number), '--repo', repo]);
    return res.status === 'ok' ? ok(true) : classifyGh(res);
  }
}
