/**
 * GitHub Issues → fork issues ingestion (work-loop doctrine, spec Slice 0 —
 * see docs/architecture/work-loop.md). Per the constitution's "single writer
 * per phase" table: GitHub Issues is the system of record for the
 * *statement* phase; once a fork issue is promoted out of `backlog` the
 * cockpit owns it and this job never touches it again. Two-way live sync is
 * explicitly ruled out — this is a polling mirror, not a webhook relay.
 *
 * Supersedes `IssueIngestionAdapter` (./ingest-service.ts), which mirrored
 * GitHub issues into pipeline `cases` because the fork's `issues` table had
 * no GitHub linkage at the time. It now does (`originKind: plugin:github`,
 * `originId`, `originFingerprint`), so this is the real ingestion target —
 * see that file's header for the deprecation note.
 *
 * Idempotency: `originFingerprint = github:{repo}#{number}` is a stable key
 * scoped to (companyId, fingerprint) — re-ingesting upserts rather than
 * duplicating, mirroring the `productivity-review.ts` /
 * `recovery/service.ts` fingerprint convention elsewhere in this service.
 *
 * Every company/repo/issue is failure-isolated: a bad repo, a `gh` failure,
 * or a single issue's upsert error is logged and skipped, never throws the
 * job down (same shape as `observe/attribution-refresh.ts`).
 */
import { and, eq, ne } from "drizzle-orm";
import { type Db, cloudScopeBindings, companies, issues } from "@paperclipai/db";
import { issueService } from "../../services/issues.js";
import { periodicJobIntervalMs, startPeriodicJob } from "../../lib/periodic-job.js";
import {
  GITHUB_DONE_LABEL,
  GITHUB_PROMOTED_LABEL,
  parseGithubOriginId,
} from "./github-issue-reflect.js";
import { GitHubIssuesSource } from "./ticket-source.js";
import type { TicketSource } from "./ticket-source.js";

export type GithubIssueIngestAction =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped_not_backlog"
  | "cancelled_closed_on_github"
  | "source_unavailable"
  | "listing_truncated"
  | "cancel_skipped_unconfirmed"
  | "reconciled"
  | "failed";

export type GithubIssueIngestEntry = {
  companyId: string;
  companyName: string | null;
  repo: string;
  originId: string | null;
  action: GithubIssueIngestAction;
  detail: string;
};

export type GithubIssueIngestSummary = {
  startedAt: string;
  finishedAt: string;
  entries: GithubIssueIngestEntry[];
};

const LOG_PREFIX = "[github-issue-ingest]";

const GITHUB_ORIGIN_FINGERPRINT_UNIQUE_CONSTRAINT = "issues_github_origin_fingerprint_uq";

/** Detects a Postgres unique-violation (23505) against
 *  `issues_github_origin_fingerprint_uq` specifically, so a genuinely
 *  unexpected DB error still propagates instead of being swallowed. Mirrors
 *  the `isUniqueConstraintConflict` idiom in services/task-watchdogs.ts. */
function isGithubOriginFingerprintUniqueConflict(error: unknown): boolean {
  const queue: unknown[] = [error];
  const messages: string[] = [];
  let hasUniqueCode = false;
  let hasConstraint = false;
  for (const candidate of queue) {
    if (!candidate || typeof candidate !== "object") continue;
    const typed = candidate as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
      message?: string;
    };
    if (typed.code === "23505") hasUniqueCode = true;
    if (
      typed.constraint === GITHUB_ORIGIN_FINGERPRINT_UNIQUE_CONSTRAINT ||
      typed.constraint_name === GITHUB_ORIGIN_FINGERPRINT_UNIQUE_CONSTRAINT
    ) {
      hasConstraint = true;
    }
    if (typed.message) messages.push(typed.message);
    if (typed.cause) queue.push(typed.cause);
  }
  const message = messages.join("\n");
  return (
    (hasUniqueCode || message.includes("duplicate key value violates unique constraint")) &&
    (hasConstraint || message.includes(GITHUB_ORIGIN_FINGERPRINT_UNIQUE_CONSTRAINT))
  );
}

/** Stable dedupe key for a GitHub issue, scoped by company via the row's
 *  own companyId (not embedded in the fingerprint itself). */
export function githubOriginFingerprint(ticketId: string): string {
  return `github:${ticketId}`;
}

async function companiesWithGithubRepos(
  db: Db,
): Promise<Array<{ companyId: string; companyName: string | null; githubRepos: string[] }>> {
  const rows = await db
    .select({ scopeId: cloudScopeBindings.scopeId, githubRepos: cloudScopeBindings.githubRepos })
    .from(cloudScopeBindings)
    .where(eq(cloudScopeBindings.scopeType, "company"));
  const bound = rows.filter((r) => (r.githubRepos?.length ?? 0) > 0);
  if (bound.length === 0) return [];

  const companyRows = await db.select({ id: companies.id, name: companies.name }).from(companies);
  const nameById = new Map(companyRows.map((c) => [c.id, c.name]));

  return bound.map((r) => ({
    companyId: r.scopeId,
    companyName: nameById.get(r.scopeId) ?? null,
    githubRepos: r.githubRepos ?? [],
  }));
}

async function ingestRepoForCompany(
  db: Db,
  svc: ReturnType<typeof issueService>,
  source: TicketSource,
  company: { companyId: string; companyName: string | null },
  repo: string,
  log: (line: string) => void,
): Promise<GithubIssueIngestEntry[]> {
  const entries: GithubIssueIngestEntry[] = [];
  const listed = await source.list(repo);
  if (!listed.ok) {
    entries.push({
      companyId: company.companyId,
      companyName: company.companyName,
      repo,
      originId: null,
      action: "source_unavailable",
      detail: listed.message,
    });
    log(`company=${company.companyId} repo=${repo} source unavailable: ${listed.message}`);
    return entries;
  }

  // Finding 2 (adversarial architecture review): a full page from
  // `source.list` means there may be more open issues upstream than we
  // fetched. Truncation must never be silent — log it as a classified
  // warning so a repo growing past the page size is visible in ops, not
  // just inferred later from mysteriously-vanishing backlog issues.
  if (listed.truncated) {
    entries.push({
      companyId: company.companyId,
      companyName: company.companyName,
      repo,
      originId: null,
      action: "listing_truncated",
      detail: `gh issue list returned a full page (>= ${listed.value.length} issues) — some open issues on ${repo} may not have been fetched this pass`,
    });
    log(`company=${company.companyId} repo=${repo} WARNING: gh issue list page full — listing may be truncated`);
  }

  const openOriginIds = new Set(listed.value.map((t) => t.id));

  for (const ticket of listed.value) {
    const fingerprint = githubOriginFingerprint(ticket.id);
    try {
      const existing = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, company.companyId), eq(issues.originFingerprint, fingerprint)))
        .then((rows) => rows[0] ?? null);

      if (!existing) {
        try {
          await svc.create(company.companyId, {
            title: ticket.title,
            description: ticket.body || null,
            status: "backlog",
            originKind: "plugin:github",
            originId: ticket.id,
            originFingerprint: fingerprint,
          });
        } catch (e) {
          // Finding 5b (adversarial architecture review): the scheduled tick
          // and a manual `POST /apex/github-ingest` can race on the same
          // not-yet-ingested GitHub issue. `issues_github_origin_fingerprint_uq`
          // (migration 0151) makes the dedupe atomic at the DB layer — the
          // loser of the race hits a unique-violation here instead of
          // double-creating. Treat that as a benign race, not a failure.
          if (isGithubOriginFingerprintUniqueConflict(e)) {
            entries.push({
              companyId: company.companyId,
              companyName: company.companyName,
              repo,
              originId: ticket.id,
              action: "unchanged",
              detail: "lost a concurrent create race (another ingest run/manual trigger created it first) — not duplicated",
            });
            log(`company=${company.companyId} repo=${repo} issue=${ticket.id} create raced, deduped by unique index`);
            continue;
          }
          throw e;
        }
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: ticket.id,
          action: "created",
          detail: `ingested from ${ticket.url}`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${ticket.id} created`);
        continue;
      }

      if (existing.status !== "backlog") {
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: ticket.id,
          action: "skipped_not_backlog",
          detail: `fork issue ${existing.identifier ?? existing.id} is ${existing.status} — cockpit owns it since promotion, not touched`,
        });
        continue;
      }

      const nextDescription = ticket.body || null;
      if (existing.title === ticket.title && (existing.description ?? null) === nextDescription) {
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: ticket.id,
          action: "unchanged",
          detail: "title/description already in sync",
        });
        continue;
      }

      // Finding 5a (adversarial architecture review): the `existing.status
      // !== "backlog"` check above and this write used to be two separate
      // statements — a promotion racing in between would let this job's
      // title/description refresh clobber a cockpit-owned issue. This helper
      // re-checks `status = 'backlog'` atomically in the same UPDATE, so a
      // concurrent promotion makes it a no-op (returns null) instead of a
      // race.
      const updated = await svc.updateBacklogFieldsIfStillBacklog(existing.id, {
        title: ticket.title,
        description: nextDescription,
      });
      if (!updated) {
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: ticket.id,
          action: "skipped_not_backlog",
          detail: `fork issue ${existing.identifier ?? existing.id} was promoted out of backlog concurrently — refresh skipped`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${ticket.id} skip update: promoted concurrently`);
        continue;
      }
      entries.push({
        companyId: company.companyId,
        companyName: company.companyName,
        repo,
        originId: ticket.id,
        action: "updated",
        detail: "title/description refreshed from GitHub (still backlog, not yet promoted)",
      });
      log(`company=${company.companyId} repo=${repo} issue=${ticket.id} updated`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      entries.push({
        companyId: company.companyId,
        companyName: company.companyName,
        repo,
        originId: ticket.id,
        action: "failed",
        detail,
      });
      log(`company=${company.companyId} repo=${repo} issue=${ticket.id} FAILED: ${detail}`);
    }
  }

  // Closed-on-GitHub detection: `source.list` only returns open issues, so a
  // previously-ingested backlog issue whose originId no longer appears in
  // this pass is presumed closed upstream. Issues already promoted out of
  // backlog are untouched regardless (single-writer rule).
  try {
    const repoPrefix = `${repo}#`;
    const backlogRows = await db
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, company.companyId),
          eq(issues.originKind, "plugin:github"),
          eq(issues.status, "backlog"),
        ),
      );
    for (const row of backlogRows) {
      if (!row.originId || !row.originId.startsWith(repoPrefix)) continue;
      if (openOriginIds.has(row.originId)) continue;

      // Finding 2 (adversarial architecture review): "absent from list()"
      // used to be treated as "closed", but `list()` is paginated — a repo
      // with more open issues than the page size would silently mass-cancel
      // legitimate backlog. Never cancel on absence alone: confirm the issue
      // is actually closed via a direct `get()`. A `get()` failure (network,
      // auth, rate limit, or a since-deleted issue) is unknown, not closed —
      // skip and log classified, never cancel on a guess.
      const parsed = parseGithubOriginId(row.originId);
      if (!parsed) {
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: row.originId,
          action: "cancel_skipped_unconfirmed",
          detail: `fork issue ${row.identifier ?? row.id} has an unparseable originId (${row.originId}) — skipping cancel`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${row.originId} skip cancel: unparseable originId`);
        continue;
      }
      const confirmed = await source.get(parsed.repo, parsed.number);
      if (!confirmed.ok) {
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: row.originId,
          action: "cancel_skipped_unconfirmed",
          detail: `could not confirm GitHub state for ${row.originId} (get failed: ${confirmed.message}) — treating as unknown, not cancelling`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${row.originId} skip cancel: get() failed: ${confirmed.message}`);
        continue;
      }
      const confirmedClosed = /closed/i.test(confirmed.value.status);
      if (!confirmedClosed) {
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: row.originId,
          action: "cancel_skipped_unconfirmed",
          detail: `fork issue ${row.identifier ?? row.id} absent from the (possibly truncated) listing but get() shows it still open — not cancelling`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${row.originId} skip cancel: get() shows still open`);
        continue;
      }

      try {
        await svc.update(row.id, { status: "cancelled" });
        await svc.addComment(
          row.id,
          `Closed on GitHub (${repo}) while still in backlog — auto-cancelled by the GitHub ingest job.`,
          {},
          { authorType: "system" },
        );
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: row.originId,
          action: "cancelled_closed_on_github",
          detail: `fork issue ${row.identifier ?? row.id} cancelled — no longer open on GitHub`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${row.originId} cancelled (closed on GitHub)`);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        entries.push({
          companyId: company.companyId,
          companyName: company.companyName,
          repo,
          originId: row.originId,
          action: "failed",
          detail: `closed-on-GitHub cancel failed: ${detail}`,
        });
        log(`company=${company.companyId} repo=${repo} issue=${row.originId} FAILED to cancel: ${detail}`);
      }
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log(`company=${company.companyId} repo=${repo} closed-on-GitHub sweep FAILED: ${detail}`);
  }

  entries.push(...(await reconcilePromotedAndDoneMirrors(db, source, company, repo, log)));

  return entries;
}

/**
 * Finding 13 (adversarial architecture review): `reflectGithubIssueTransition`
 * is fire-and-forget — a failed label/close call is a classified log line
 * and nothing else, permanently. This sweep runs every ingest tick (6h by
 * default) and re-checks every non-backlog `plugin:github` mirror: promoted
 * mirrors should carry `apex:promoted`, done/cancelled mirrors should carry
 * `apex:done` and be closed upstream. Anything missing gets a best-effort
 * re-apply, classified and logged either way. Only runs against sources that
 * actually expose the label/close surface (real `GitHubIssuesSource`) —
 * a minimal `TicketSource` test double is a no-op here, same as
 * `reflectGithubIssueTransition` treats it.
 */
async function reconcilePromotedAndDoneMirrors(
  db: Db,
  source: TicketSource & Partial<Pick<GitHubIssuesSource, "addLabel" | "close">>,
  company: { companyId: string; companyName: string | null },
  repo: string,
  log: (line: string) => void,
): Promise<GithubIssueIngestEntry[]> {
  const entries: GithubIssueIngestEntry[] = [];
  if (!source.addLabel || !source.close) return entries;

  const repoPrefix = `${repo}#`;
  const mirroredRows = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.companyId, company.companyId),
        eq(issues.originKind, "plugin:github"),
        ne(issues.status, "backlog"),
      ),
    );

  for (const row of mirroredRows) {
    if (!row.originId || !row.originId.startsWith(repoPrefix)) continue;
    const parsed = parseGithubOriginId(row.originId);
    if (!parsed) continue;

    try {
      const confirmed = await source.get(parsed.repo, parsed.number);
      if (!confirmed.ok) {
        log(`company=${company.companyId} repo=${repo} issue=${row.originId} reconcile skipped: get() failed: ${confirmed.message}`);
        continue;
      }

      const isTerminal = row.status === "done" || row.status === "cancelled";
      const expectedLabel = isTerminal ? GITHUB_DONE_LABEL : GITHUB_PROMOTED_LABEL;
      const hasExpectedLabel = (confirmed.value.labels ?? []).includes(expectedLabel);
      const isClosedUpstream = /closed/i.test(confirmed.value.status);
      const needsLabel = !hasExpectedLabel;
      const needsClose = isTerminal && !isClosedUpstream;
      if (!needsLabel && !needsClose) continue;

      const problems: string[] = [];
      if (needsLabel) problems.push(`missing ${expectedLabel} label`);
      if (needsClose) problems.push("not closed upstream");

      let labelOk = !needsLabel;
      let closeOk = !needsClose;
      if (needsLabel) {
        const labelRes = await source.addLabel(parsed.repo, parsed.number, expectedLabel);
        labelOk = labelRes.ok;
        if (!labelRes.ok) {
          log(`company=${company.companyId} repo=${repo} issue=${row.originId} reconcile addLabel failed: ${labelRes.message}`);
        }
      }
      if (needsClose) {
        const closeRes = await source.close(parsed.repo, parsed.number);
        closeOk = closeRes.ok;
        if (!closeRes.ok) {
          log(`company=${company.companyId} repo=${repo} issue=${row.originId} reconcile close failed: ${closeRes.message}`);
        }
      }

      const fixed = labelOk && closeOk;
      entries.push({
        companyId: company.companyId,
        companyName: company.companyName,
        repo,
        originId: row.originId,
        action: fixed ? "reconciled" : "failed",
        detail: `${problems.join(", ")} — ${fixed ? "re-applied" : "re-apply attempt incomplete"}`,
      });
      log(`company=${company.companyId} repo=${repo} issue=${row.originId} reconcile: ${problems.join(", ")} -> ${fixed ? "fixed" : "still incomplete"}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      entries.push({
        companyId: company.companyId,
        companyName: company.companyName,
        repo,
        originId: row.originId,
        action: "failed",
        detail: `reconcile threw: ${detail}`,
      });
      log(`company=${company.companyId} repo=${repo} issue=${row.originId} reconcile FAILED: ${detail}`);
    }
  }

  return entries;
}

/**
 * Runs one full ingest pass: every company with bound GitHub repos, every
 * bound repo. Returns a summary regardless of individual failures — this
 * function itself never throws.
 */
export async function runGithubIssueIngest(
  db: Db,
  opts: { source?: TicketSource; log?: (line: string) => void } = {},
): Promise<GithubIssueIngestSummary> {
  const startedAt = new Date().toISOString();
  const source = opts.source ?? new GitHubIssuesSource();
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} ${line}`));
  const svc = issueService(db);

  const entries: GithubIssueIngestEntry[] = [];
  const companiesToIngest = await companiesWithGithubRepos(db);

  for (const company of companiesToIngest) {
    for (const repo of company.githubRepos) {
      const repoEntries = await ingestRepoForCompany(db, svc, source, company, repo, log);
      entries.push(...repoEntries);
    }
  }

  return { startedAt, finishedAt: new Date().toISOString(), entries };
}

/** Interval (ms) from `APEX_GITHUB_INGEST_HOURS` (default 6h, 0 disables). */
export function githubIngestIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  return periodicJobIntervalMs("APEX_GITHUB_INGEST_HOURS", 6, env);
}

/** First-run delay after boot — same 5-minute deliberate offset as the
 *  attribution-refresh job (this shells `gh` per bound repo, not on the fast
 *  startup-reconciliation path other monitors use). */
export const GITHUB_INGEST_INITIAL_DELAY_MS = 5 * 60 * 1000;

/**
 * Wires the recurring ingest into server startup via the shared
 * `startPeriodicJob` helper (Finding 8, adversarial architecture review —
 * this and `startAttributionRefreshScheduler` were ~30 duplicated lines of
 * hand-rolled `setTimeout`/`setInterval` each). Returns a disposer that
 * clears both timers — call it on shutdown. A 0-hour interval (env
 * override) disables scheduling entirely; the caller can still trigger a
 * run on demand via `runGithubIssueIngest` directly (used by the manual
 * `POST /apex/github-ingest` route).
 */
export function startGithubIssueIngestScheduler(
  db: Db,
  opts: { intervalMs?: number; initialDelayMs?: number; log?: (line: string) => void } = {},
): () => void {
  const log = opts.log ?? ((line: string) => console.log(`${LOG_PREFIX} ${line}`));
  return startPeriodicJob({
    name: "github-issue-ingest",
    envVar: "APEX_GITHUB_INGEST_HOURS",
    defaultHours: 6,
    initialDelayMs: opts.initialDelayMs ?? GITHUB_INGEST_INITIAL_DELAY_MS,
    intervalMs: opts.intervalMs,
    log,
    run: () => runGithubIssueIngest(db, { log }),
  });
}
