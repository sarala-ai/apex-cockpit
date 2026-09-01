/**
 * THE LOCK ORDER: `issues` BEFORE `heartbeat_runs`. Always. No exceptions.
 *
 * ── Why there has to be a rule at all ────────────────────────────────────────
 *
 * An issue and the run executing it are locked together all over this server:
 * the execution lock lives on the issue (`issues.execution_run_id`,
 * `issues.checkout_run_id`) while the fact that decides whether the lock is
 * still real — is the run terminal? — lives on the run. Nobody can settle that
 * question by reading one row, so every one of those paths takes two row locks.
 *
 * Two row locks taken in two different orders by two transactions is a
 * deadlock, and it is not a rare one. `adoptUnownedCheckoutRun` locked the run
 * and then wrote the issue; `clearExecutionRunIfTerminal`, fifty lines below
 * it, locked the issue and then the run. Both are correct on their own. Run
 * concurrently — which the heartbeat dispatcher does routinely, because run
 * finalization and the agent-step completion hook are deliberately
 * fire-and-forget — and Postgres kills one of them with `deadlock detected`.
 *
 * A retry loop would hide this. It is not hidden: the order is stated here and
 * the module makes the wrong order unwritable.
 *
 * ── Why `issues` first, and not the other way round ──────────────────────────
 *
 * 1. `heartbeat_runs.issue_id` references `issues.id`. The issue is the parent
 *    and the durable entity; the run is the child and the ephemeral one.
 *    Parent-before-child is the order a reader guesses without being told,
 *    which is the property that makes a convention survive.
 * 2. Every one of these paths already STARTS from an issue — it is handed an
 *    issue id and has to go find the run. Only after reading the issue row is
 *    the run id even known (`issue.executionRunId`, `issue.checkoutRunId`).
 *    "Issues first" is therefore the order most call sites want anyway; the
 *    inverted one had to reach for a run id it was passed separately.
 * 3. Three of the four two-table transactions in `services/issues.ts` already
 *    obeyed it. Standardising on the majority is one edit, not four.
 *
 * ── How the order is enforced ────────────────────────────────────────────────
 *
 * `lockHeartbeatRunRows` will not compile without an `IssueLockHeld` token, and
 * the only way to obtain one is to call `lockIssueRow` first — on the same
 * transaction. A future edit cannot reintroduce the inversion by accident,
 * because the inverted spelling is not expressible.
 *
 * ── The third acquirer: FK cascade on DELETE ─────────────────────────────────
 *
 * `issues.execution_run_id` and `issues.checkout_run_id` are `ON DELETE SET
 * NULL`. So `DELETE FROM heartbeat_runs` is SECRETLY a two-table statement:
 * Postgres locks the run rows, then its RI trigger fires
 * `UPDATE ONLY issues SET execution_run_id = NULL WHERE ...`. That is
 * heartbeat_runs-then-issues — the forbidden order — and no amount of care at
 * the call site changes what the trigger does.
 *
 * The only way to delete runs in conformance is to acquire the issue side
 * FIRST, in a separate earlier statement, and leave the trigger nothing to do.
 * That is `detachIssueRunReferences`, which any run-deleting path must call
 * before its delete.
 */
import { eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues } from "@paperclipai/db";

/** The outer `db` or a transaction handle — spelled the way `services/pipelines.ts`
 *  spells it, because drizzle does not export the transaction type directly. */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

declare const issueLockBrand: unique symbol;

/**
 * Proof that this transaction already holds the issue's row lock. Unforgeable
 * outside this module: the brand is a private unique symbol, so the only way
 * to get one is `lockIssueRow`.
 */
export type IssueLockHeld = {
  readonly [issueLockBrand]: "issues-before-heartbeat_runs";
  readonly issueId: string;
};

export type LockedIssueRow = {
  id: string;
  status: string;
  assigneeAgentId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
};

/**
 * STEP ONE, always. Takes the issue's row lock and reads the columns every
 * caller of this pair needs, so nobody is tempted to read them before locking.
 *
 * Returns `null` when the issue does not exist — there is nothing to lock and
 * nothing downstream can be true, so no token is issued.
 */
export async function lockIssueRow(
  tx: DbLike,
  issueId: string,
): Promise<{ lock: IssueLockHeld; row: LockedIssueRow } | null> {
  const row = await tx
    .select({
      id: issues.id,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .for("update")
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  return { lock: { issueId } as IssueLockHeld, row: row as LockedIssueRow };
}

/**
 * STEP TWO. The `lock` parameter is the whole point: it cannot be constructed,
 * so this call is unreachable from a transaction that has not already taken
 * the issue's lock.
 *
 * Run ids are locked in a stable sorted order, so two transactions locking the
 * same PAIR of runs (adoption: the stale run and the actor's run) cannot
 * deadlock against each other either.
 */
export async function lockHeartbeatRunRows(
  tx: DbLike,
  lock: IssueLockHeld,
  runIds: Array<string | null | undefined>,
): Promise<void> {
  void lock;
  const ids = [...new Set(runIds.filter((id): id is string => typeof id === "string" && id.length > 0))].sort();
  for (const id of ids) {
    await tx.execute(sql`select ${heartbeatRuns.id} from ${heartbeatRuns} where ${heartbeatRuns.id} = ${id} for update`);
  }
}

/** Read a locked run's status. Convenience only — the lock is already held. */
export async function readLockedRunStatus(tx: DbLike, runId: string): Promise<string | null> {
  return await tx
    .select({ status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0]?.status ?? null);
}

/**
 * Release the issue-side references to runs that are about to be deleted, so
 * the subsequent `DELETE FROM heartbeat_runs` has no `ON DELETE SET NULL`
 * trigger left to fire and therefore never touches `issues` at all.
 *
 * Call this IMMEDIATELY BEFORE deleting runs. It acquires `issues` first,
 * which is the order; the delete then acquires only `heartbeat_runs`.
 *
 * `runIds` omitted means "every run" — the shape a full teardown or reset
 * wants. Passing an explicit list scopes it.
 */
export async function detachIssueRunReferences(
  db: DbLike,
  runIds?: string[],
): Promise<void> {
  if (runIds !== undefined && runIds.length === 0) return;
  await db
    .update(issues)
    .set({ executionRunId: null })
    .where(runIds ? inArray(issues.executionRunId, runIds) : isNotNull(issues.executionRunId));
  await db
    .update(issues)
    .set({ checkoutRunId: null })
    .where(runIds ? inArray(issues.checkoutRunId, runIds) : isNotNull(issues.checkoutRunId));
}

/** Exported for tests that assert the rule rather than race it. */
export const LOCK_ORDER = ["issues", "heartbeat_runs"] as const;
