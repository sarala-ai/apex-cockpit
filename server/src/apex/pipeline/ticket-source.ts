/**
 * TicketSource seam (spec 002). GitHub Issues is the source of truth this
 * milestone; repo/SpecKit files and Linear slot behind the same interface later.
 */

import { err, ok, type Result } from '../errors.js';
import { run } from '../exec.js';
import type { Ticket } from './types.js';

export interface TicketSource {
  /** List candidate tickets (open issues) for a repo. */
  list(repo: string): Promise<Result<Ticket[]> & { source: string }>;
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
  async list(repo: string): Promise<Result<Ticket[]> & { source: string }> {
    if (!repo) return { ...err('empty', 'Pass a repo (owner/name).'), source: 'no-repo' };
    const res = await run('gh', [
      'issue', 'list', '--repo', repo, '--state', 'open', '--limit', '30',
      '--json', 'number,title,body,url,state',
    ]);
    if (res.status !== 'ok') return { ...classifyGh(res), source: 'unavailable' };
    try {
      const issues = JSON.parse(res.stdout) as GhIssue[];
      return { ...ok(issues.map((i) => toTicket(repo, i))), source: 'gh' };
    } catch {
      return { ...err('parse-failed', 'Could not parse gh issue JSON.'), source: 'unavailable' };
    }
  }

  async get(repo: string, number: number): Promise<Result<Ticket> & { source: string }> {
    const res = await run('gh', [
      'issue', 'view', String(number), '--repo', repo,
      '--json', 'number,title,body,url,state',
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
}
