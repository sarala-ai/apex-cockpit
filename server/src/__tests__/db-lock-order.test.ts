/**
 * THE LOCK ORDER, PINNED: `issues` before `heartbeat_runs`.
 *
 * This is a real deadlock test, not an order-shaped assertion. It builds the
 * cycle deterministically rather than racing for it, so it either deadlocks or
 * it does not — there is no flaky middle.
 *
 * The construction:
 *
 *   1. A CONTROL transaction takes the issue's row lock and holds it. It stands
 *      in for every issues-first path in the server (`clearExecutionRunIfTerminal`,
 *      `adoptStaleCheckoutRun`, the case transaction's permission clear …), all
 *      of which lock the issue and then reach for a run.
 *   2. `companyService.remove()` runs concurrently. Somewhere inside it is
 *      `DELETE FROM heartbeat_runs`, which — because `issues.execution_run_id`
 *      is `ON DELETE SET NULL` — is secretly a two-table statement.
 *        * INVERTED (the bug): it locks the run rows, then its RI trigger's
 *          `UPDATE issues` blocks on the control transaction. It is now parked
 *          HOLDING the run lock.
 *        * CONFORMING (the fix): `detachIssueRunReferences` nulls the issue
 *          side FIRST, so it blocks on the control transaction while holding no
 *          run lock at all, and the delete has nothing left to cascade.
 *   3. The control transaction then asks for the run — the second half of what
 *      an issues-first path always does.
 *        * INVERTED: control waits for the delete, the delete waits for
 *          control. `deadlock detected`.
 *        * CONFORMING: control takes it immediately, because nobody holds it.
 *
 * Step 3 completing at all is the assertion. That it completes while the other
 * side is still pending is the second one, and it is what pins the ORDER rather
 * than merely the absence of one deadlock: it can only be true if the concurrent
 * path parked on `issues` before touching `heartbeat_runs`.
 *
 * MUTATION CHECK (performed): removing the `detachIssueRunReferences` call from
 * `services/companies.ts` makes this test fail with
 *   PostgresError: deadlock detected ... query: delete from "heartbeat_runs"
 * — Postgres picks the delete as the victim, so it surfaces on
 * `concurrentError`; the assertion on `controlError` covers the other choice of
 * victim. Restoring the call makes it pass.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.ts";
import { detachIssueRunReferences } from "../services/db-lock-order.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres lock-order tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("db lock order: issues before heartbeat_runs", () => {
  let db!: ReturnType<typeof createDb>;
  /** A SECOND pool. The control transaction has to be a genuinely different
   *  backend from the one running the concurrent path, or there is no cycle to
   *  detect — only one connection taking two locks in sequence. */
  let control!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-db-lock-order-");
    db = createDb(tempDb.connectionString);
    control = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await detachIssueRunReferences(db);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.execute(sql`delete from company_skills`);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssueHoldingARun() {
    const [company] = await db
      .insert(companies)
      .values({
        name: "Lock Order Co",
        issuePrefix: `L${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Worker",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: company!.id, agentId: agent!.id, status: "running" })
      .returning();
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company!.id,
        title: "Held by a run",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agent!.id,
        checkoutRunId: run!.id,
        executionRunId: run!.id,
        executionLockedAt: new Date(),
      })
      .returning();
    return { company: company!, agent: agent!, run: run!, issue: issue! };
  }

  it("never gives a run-lock holder a reason to wait on an issue lock", async () => {
    const seeded = await seedIssueHoldingARun();

    /** Held until the concurrent path has had time to reach its delete. */
    let concurrentPathParkedResolve!: () => void;
    const concurrentPathParked = new Promise<void>((resolve) => {
      concurrentPathParkedResolve = resolve;
    });

    // Step 1 — the control transaction takes the ISSUE and keeps it. Released
    // only when `releaseIssue` resolves, so the whole interleaving below is
    // driven rather than raced.
    let releaseIssue!: () => void;
    const issueLockReleased = new Promise<void>((resolve) => {
      releaseIssue = resolve;
    });
    let issueLockTaken!: () => void;
    const issueLockHeld = new Promise<void>((resolve) => {
      issueLockTaken = resolve;
    });
    /** Resolves when the control transaction has the RUN lock too. */
    let runLockTaken!: () => void;
    const runLockHeld = new Promise<void>((resolve) => {
      runLockTaken = resolve;
    });

    let controlError: unknown = null;
    const controlTx = control
      .transaction(async (tx) => {
        await tx.execute(sql`select id from issues where id = ${seeded.issue.id} for update`);
        issueLockTaken();
        await concurrentPathParked;
        // Step 3 — the second half of every issues-first path. With the
        // inversion this is the moment the cycle closes.
        await tx.execute(sql`select id from heartbeat_runs where id = ${seeded.run.id} for update`);
        runLockTaken();
        await issueLockReleased;
      })
      .catch((err) => {
        controlError = err;
        // Unblock the waiters so a failure surfaces as an assertion rather than
        // a test timeout.
        runLockTaken();
      });

    await issueLockHeld;

    // Step 2 — the concurrent path. `companyService.remove` deletes this
    // company's heartbeat runs, which is the FK-cascade acquirer.
    let concurrentSettled = false;
    let concurrentError: unknown = null;
    const concurrent = companyService(db)
      .remove(seeded.company.id)
      .then(
        () => {
          concurrentSettled = true;
        },
        (err) => {
          concurrentSettled = true;
          concurrentError = err;
        },
      );

    // Give it long enough to reach the delete and park on the issue lock.
    // Postgres' own `deadlock_timeout` is 1s, so an inverted acquisition has
    // not yet been reported by the time the control transaction moves on —
    // which is exactly the state that must produce a cycle if one exists.
    await new Promise((resolve) => setTimeout(resolve, 750));

    concurrentPathParkedResolve();
    await runLockHeld;

    // THE ASSERTION. Reached only because the concurrent path was parked
    // without holding the run.
    expect(controlError).toBeNull();
    // …and it was still parked. If it had already finished, the two locks were
    // never actually contended and this test proved nothing.
    expect(concurrentSettled).toBe(false);

    releaseIssue();
    await controlTx;
    await concurrent;
    expect(concurrentError).toBeNull();

    // The concurrent path really did the work — otherwise the interleaving
    // above was against a no-op.
    const remainingRuns = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    expect(remainingRuns).toHaveLength(0);
  }, 120_000);
});
