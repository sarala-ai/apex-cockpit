import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, environmentLeases, environments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { environmentLeaseReaper } from "../services/environment-lease-reaper.ts";
import { environmentRuntimeService, type EnvironmentRuntimeDriver } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres environment lease reaper tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("environment lease reaper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("environment-lease-reaper-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE "environment_leases", "environments", "companies" RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedLease(input: {
    status: "released" | "failed" | "expired" | "pending_cleanup" | "retained";
    cleanupStatus: "failed" | "pending" | "success";
    leasePolicy?: "ephemeral" | "reuse_by_environment" | "retain_on_failure";
  }) {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    const leaseId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Paperclip ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(environments).values({
      id: environmentId,
      name: `Sandbox ${environmentId.slice(0, 6)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "kubernetes" },
    });
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      environmentId,
      status: input.status,
      leasePolicy: input.leasePolicy ?? "ephemeral",
      provider: "kubernetes",
      providerLeaseId: `sbx-${leaseId.slice(0, 8)}`,
      releasedAt: input.status === "retained" ? null : new Date(),
      cleanupStatus: input.cleanupStatus,
      metadata: { driver: "sandbox", namespace: "tenant-alpha", provider: "kubernetes" },
    });
    return { companyId, environmentId, leaseId, providerLeaseId: `sbx-${leaseId.slice(0, 8)}` };
  }

  function fakeSandboxDriver(providerRelease: () => Promise<void>) {
    const environmentsSvc = environmentService(db);
    const releaseRunLease = vi.fn(async (input: Parameters<EnvironmentRuntimeDriver["releaseRunLease"]>[0]) => {
      let cleanupStatus: "success" | "failed" = "success";
      try {
        await providerRelease();
      } catch {
        cleanupStatus = "failed";
      }
      return await environmentsSvc.releaseLease(input.lease.id, input.status, { cleanupStatus });
    });
    const destroyRunLease = vi.fn(async (input: { lease: { id: string }; failureReason?: string }) => {
      let cleanupStatus: "success" | "failed" = "success";
      try {
        await providerRelease();
      } catch {
        cleanupStatus = "failed";
      }
      return await environmentsSvc.releaseLease(
        input.lease.id,
        cleanupStatus === "success" ? "expired" : "pending_cleanup",
        { failureReason: input.failureReason, cleanupStatus },
      );
    });
    const driver: EnvironmentRuntimeDriver = {
      driver: "sandbox",
      acquireRunLease: async () => {
        throw new Error("reaper never acquires");
      },
      releaseRunLease,
      destroyRunLease,
    };
    return { driver, releaseRunLease, destroyRunLease };
  }

  it("finalizes a lease whose provider release now succeeds and records the attempt", async () => {
    const seeded = await seedLease({ status: "released", cleanupStatus: "failed" });
    const fake = fakeSandboxDriver(async () => undefined);
    const lines: string[] = [];
    const reaper = environmentLeaseReaper(db, {
      runtime: environmentRuntimeService(db, { drivers: [fake.driver] }),
      log: (line) => lines.push(line),
      now: () => new Date("2026-09-03T10:00:00.000Z"),
    });

    await expect(reaper.sweep()).resolves.toEqual({ reclaimed: 1, stillPending: 0 });

    expect(fake.releaseRunLease).toHaveBeenCalledTimes(1);
    expect(fake.releaseRunLease.mock.calls[0]?.[0]).toMatchObject({
      status: "released",
      lease: { id: seeded.leaseId, providerLeaseId: seeded.providerLeaseId },
    });
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(lease?.status).toBe("released");
    expect(lease?.cleanupStatus).toBe("success");
    expect(lease?.metadata).toMatchObject({
      namespace: "tenant-alpha",
      cleanupRetry: { attempts: 1, lastOutcome: "success", lastAttemptAt: "2026-09-03T10:00:00.000Z", lastError: null },
    });
    expect(lines).toEqual(["reclaimed 1 lease(s) (0 still pending)"]);

    // A reclaimed lease is out of the reaper's view on the next tick.
    await expect(reaper.sweep()).resolves.toEqual({ reclaimed: 0, stillPending: 0 });
    expect(fake.releaseRunLease).toHaveBeenCalledTimes(1);
  });

  it("keeps a lease pending and names it for the operator when the provider release still fails", async () => {
    const seeded = await seedLease({ status: "failed", cleanupStatus: "failed" });
    const fake = fakeSandboxDriver(async () => {
      throw new Error("cluster unreachable");
    });
    const lines: string[] = [];
    const reaper = environmentLeaseReaper(db, {
      runtime: environmentRuntimeService(db, { drivers: [fake.driver] }),
      log: (line) => lines.push(line),
    });

    await expect(reaper.sweep()).resolves.toEqual({ reclaimed: 0, stillPending: 1 });
    await expect(reaper.sweep()).resolves.toEqual({ reclaimed: 0, stillPending: 1 });

    expect(fake.releaseRunLease).toHaveBeenCalledTimes(2);
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, seeded.leaseId));
    expect(lease?.status).toBe("failed");
    expect(lease?.cleanupStatus).toBe("failed");
    expect(lease?.metadata).toMatchObject({ cleanupRetry: { attempts: 2, lastOutcome: "failed" } });

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("after 2 attempt(s)");
    expect(lines[1]).toContain(`lease=${seeded.leaseId}`);
    expect(lines[1]).toContain(`providerLeaseId=${seeded.providerLeaseId}`);
    expect(lines[1]).toContain("namespace=tenant-alpha");
    expect(lines[1]).toContain(`environment=${seeded.environmentId}`);
  });

  it("retries pending_cleanup reusable leases through destroy and leaves retained leases alone", async () => {
    const pending = await seedLease({
      status: "pending_cleanup",
      cleanupStatus: "failed",
      leasePolicy: "reuse_by_environment",
    });
    const retained = await seedLease({
      status: "retained",
      cleanupStatus: "failed",
      leasePolicy: "retain_on_failure",
    });
    const fake = fakeSandboxDriver(async () => undefined);
    const reaper = environmentLeaseReaper(db, {
      runtime: environmentRuntimeService(db, { drivers: [fake.driver] }),
      log: () => undefined,
    });

    await expect(reaper.sweep()).resolves.toEqual({ reclaimed: 1, stillPending: 0 });

    expect(fake.destroyRunLease).toHaveBeenCalledTimes(1);
    expect(fake.destroyRunLease.mock.calls[0]?.[0]).toMatchObject({ lease: { id: pending.leaseId } });
    expect(fake.releaseRunLease).not.toHaveBeenCalled();
    const [pendingLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, pending.leaseId));
    expect(pendingLease?.status).toBe("expired");
    expect(pendingLease?.cleanupStatus).toBe("success");
    const [retainedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, retained.leaseId));
    expect(retainedLease?.status).toBe("retained");
    expect(retainedLease?.metadata).not.toHaveProperty("cleanupRetry");
  });
});
