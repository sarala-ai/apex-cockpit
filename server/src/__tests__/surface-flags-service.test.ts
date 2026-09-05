import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  orgs,
  orgSurfaceFlags,
  orgSurfaceFlagEvents,
} from "@paperclipai/db";
import type { OrgFacts } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { surfaceFlagsService } from "../services/surface-flags.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres surface-flags service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ZERO_FACTS: OrgFacts = {
  asOf: "2026-01-01T00:00:00.000Z",
  hasRepoOrCloudBinding: false,
  runsStarted: 0,
  runsCompleted: 0,
  firstRunAt: null,
  liveRunCount: 0,
  openPrCount: 0,
  deploysLanded: 0,
  gatewayCallAudited: false,
  orgMemberCount: 0,
  companyMemberCount: 0,
  goalCount: 0,
  operatorAuthHealthy: false,
};

const BOUND_FACTS: OrgFacts = { ...ZERO_FACTS, hasRepoOrCloudBinding: true, runsStarted: 1 };

describeEmbeddedPostgres("surfaceFlagsService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof surfaceFlagsService>;
  let orgId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-surface-flags-service-");
    db = createDb(tempDb.connectionString);
    svc = surfaceFlagsService(db);
  }, 40_000);

  afterEach(async () => {
    await db.delete(orgSurfaceFlagEvents);
    await db.delete(orgSurfaceFlags);
    await db.delete(orgs);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedOrg() {
    const id = randomUUID();
    await db.insert(orgs).values({ id, name: "Sarala" });
    orgId = id;
    return id;
  }

  it("list() reflects due() when no flag has ever been written", async () => {
    await seedOrg();
    const rows = await svc.list(orgId, ZERO_FACTS, false);
    const chat = rows.find((r) => r.key === "chat")!;
    const dashboard = rows.find((r) => r.key === "dashboard")!;
    const tasks = rows.find((r) => r.key === "tasks")!;
    expect(chat.visible).toBe(true); // always
    expect(dashboard.visible).toBe(true); // stage 1 due() true even at zero facts
    expect(tasks.visible).toBe(false); // gated on a first run, none yet
    expect(tasks.flag).toBeNull();
  });

  it("showAllSurfaces forces every surface visible regardless of flags or facts", async () => {
    await seedOrg();
    const rows = await svc.list(orgId, ZERO_FACTS, true);
    expect(rows.every((r) => r.visible)).toBe(true);
  });

  it("set() persists a current-state row, appends an event, and list() reflects it", async () => {
    await seedOrg();
    const flag = await svc.set(orgId, "tasks", { unveiled: true, reason: "operator asked", source: "user", actorUserId: "u1" });
    expect(flag).toMatchObject({ surfaceKey: "tasks", unveiled: true, source: "user", reason: "operator asked", actorUserId: "u1" });

    const rows = await svc.list(orgId, ZERO_FACTS, false);
    const tasks = rows.find((r) => r.key === "tasks")!;
    expect(tasks.visible).toBe(true);
    expect(tasks.flag?.source).toBe("user");

    const events = await db.select().from(orgSurfaceFlagEvents);
    expect(events.some((e) => e.orgId === orgId && e.surfaceKey === "tasks" && e.unveiled === true)).toBe(true);
  });

  it("reconcile() writes rule-sourced flags for surfaces whose due() verdict changed", async () => {
    await seedOrg();
    const diff = await svc.reconcile(orgId, BOUND_FACTS);
    const tasksChange = diff.find((d) => d.surfaceKey === "tasks");
    expect(tasksChange).toMatchObject({ unveiled: true });

    const rows = await svc.list(orgId, BOUND_FACTS, false);
    const tasks = rows.find((r) => r.key === "tasks")!;
    expect(tasks.flag?.source).toBe("rule");
    expect(tasks.visible).toBe(true);
  });

  it("INVARIANT: reconcile() never overwrites a flag an operator/chat set explicitly, even against the facts", async () => {
    await seedOrg();
    // Operator explicitly re-veils "tasks" even though a run has started.
    await svc.set(orgId, "tasks", { unveiled: false, reason: "operator hid it", source: "user" });

    const diff = await svc.reconcile(orgId, BOUND_FACTS); // due() says tasks should be unveiled now
    expect(diff.find((d) => d.surfaceKey === "tasks")).toBeUndefined();

    const rows = await svc.list(orgId, BOUND_FACTS, false);
    const tasks = rows.find((r) => r.key === "tasks")!;
    expect(tasks.flag?.source).toBe("user");
    expect(tasks.flag?.unveiled).toBe(false);
    expect(tasks.visible).toBe(false);
  });

  it("reconcile() is a no-op the second time once flags already match the rules", async () => {
    await seedOrg();
    await svc.reconcile(orgId, BOUND_FACTS);
    const secondDiff = await svc.reconcile(orgId, BOUND_FACTS);
    expect(secondDiff).toEqual([]);
  });
});
