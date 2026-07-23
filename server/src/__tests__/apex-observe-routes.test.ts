import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { apexObserveRoutes } from "../routes/apex-observe.js";
import { errorHandler } from "../middleware/index.js";

/**
 * A minimal drizzle-shaped mock. Every method is chainable (returns the builder)
 * and the builder itself is thenable, so it resolves to canned rows however the
 * chain terminates — the runs query ends on `.limit()` (with `.where()` in the
 * middle for the company filter), the issue-title query ends on an awaited
 * `.where()`. First `.select()` call → run rows; second → issue rows. `captured`
 * records the runs query's `where` condition so tests can assert company scoping
 * (undefined = global view; defined = scoped).
 */
function makeDb(runRows: unknown[], issueRows: unknown[]) {
  let call = 0;
  const captured: { runsWhere?: unknown } = {};
  const builder = (result: unknown[], isRuns: boolean) => {
    const b: Record<string, unknown> = {
      from: () => b,
      innerJoin: () => b,
      orderBy: () => b,
      limit: () => Promise.resolve(result),
      where: (cond: unknown) => {
        if (isRuns) captured.runsWhere = cond;
        return b;
      },
      then: (resolve: (v: unknown) => void) => resolve(result),
    };
    return b;
  };
  const db = {
    select: () => {
      call += 1;
      return builder(call === 1 ? runRows : issueRows, call === 1);
    },
  } as unknown as Db;
  return { db, captured };
}

function appWith(db: Db) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = { type: "agent", agentId: "a1" };
    next();
  });
  app.use(apexObserveRoutes(db));
  app.use(errorHandler);
  return app;
}

const RUN_WITH_USAGE = {
  id: "r1",
  status: "succeeded",
  startedAt: new Date("2026-07-23T08:00:00.000Z"),
  finishedAt: new Date("2026-07-23T08:01:55.000Z"),
  exitCode: 0,
  agentName: "Dev Agent",
  usageJson: {
    inputTokens: 52496,
    outputTokens: 1200,
    costUsd: 0.012,
    model: "claude-haiku-4-5",
  },
  resultJson: { stopReason: "end_turn" },
  contextSnapshot: { issueId: "i1", projectId: "p1" },
};

const RUN_NO_USAGE = {
  id: "r2",
  status: "running",
  startedAt: new Date("2026-07-23T09:00:00.000Z"),
  finishedAt: null,
  exitCode: null,
  agentName: "Dev Agent",
  usageJson: null,
  resultJson: {},
  contextSnapshot: {},
};

describe("GET /observe/agent-runs", () => {
  it("maps runs with agent, linked issue title, duration, stop reason, and usage", async () => {
    const { db } = makeDb([RUN_WITH_USAGE, RUN_NO_USAGE], [{ id: "i1", title: "Add a unit test" }]);
    const res = await request(appWith(db)).get("/observe/agent-runs");

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("db");
    expect(res.body.runs).toHaveLength(2);

    const [a, b] = res.body.runs;
    expect(a).toMatchObject({
      id: "r1",
      agentName: "Dev Agent",
      issueId: "i1",
      issueTitle: "Add a unit test",
      status: "succeeded",
      durationMs: 115_000,
      exitCode: 0,
      stopReason: "end_turn",
      usage: {
        inputTokens: 52496,
        outputTokens: 1200,
        cachedInputTokens: null,
        costUsd: 0.012,
        model: "claude-haiku-4-5",
      },
    });

    // A run with no usage / no issue / not finished → nulls, not crashes.
    expect(b).toMatchObject({
      id: "r2",
      status: "running",
      issueId: null,
      issueTitle: null,
      durationMs: null,
      usage: null,
    });
  });

  it("returns an empty list (no issue lookup) when there are no runs", async () => {
    const res = await request(appWith(makeDb([], []).db)).get("/observe/agent-runs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runs: [], source: "db" });
  });

  it("scopes runs to a company when companyId is provided, global when omitted", async () => {
    // With ?companyId → a company filter is applied to the runs query.
    const scoped = makeDb([RUN_WITH_USAGE], [{ id: "i1", title: "Add a unit test" }]);
    const res = await request(appWith(scoped.db)).get("/observe/agent-runs?companyId=co-1");
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(scoped.captured.runsWhere).toBeDefined();

    // Without companyId → global view, no company filter.
    const global = makeDb([RUN_WITH_USAGE], [{ id: "i1", title: "Add a unit test" }]);
    await request(appWith(global.db)).get("/observe/agent-runs");
    expect(global.captured.runsWhere).toBeUndefined();
  });

  it("is failure-isolated: a db error yields a note, not a 500", async () => {
    const db = {
      select: () => {
        throw new Error("db exploded");
      },
    } as unknown as Db;
    const res = await request(appWith(db)).get("/observe/agent-runs");
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
    expect(res.body.source).toBe("unavailable");
    expect(res.body.note).toContain("db exploded");
  });
});
