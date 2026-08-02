import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  goals,
  issueWorkProducts,
  issues,
  releaseArtifacts,
  releaseChanges,
  releases,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { releaseService, releaseWindow, resolveInitiative, windowsOverlap } from "../services/releases.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres release service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const T = (iso: string) => new Date(iso);

// --- pure helpers: no database needed -------------------------------------

describe("release window arithmetic", () => {
  it("gives an unreleased release no window at all", () => {
    // A planned release changed nothing in the world and must never enter a
    // confound computation.
    expect(releaseWindow({ releasedAt: null, observationWindowEndsAt: T("2026-08-01T00:00:00Z") })).toBeNull();
  });

  it("degenerates to the instant of release when no window was declared", () => {
    const window = releaseWindow({ releasedAt: T("2026-08-01T00:00:00Z"), observationWindowEndsAt: null });
    expect(window).toEqual({ start: T("2026-08-01T00:00:00Z"), end: T("2026-08-01T00:00:00Z") });
  });

  it("treats a backwards window as the instant of release rather than dropping it", () => {
    const window = releaseWindow({
      releasedAt: T("2026-08-10T00:00:00Z"),
      observationWindowEndsAt: T("2026-08-01T00:00:00Z"),
    });
    expect(window).toEqual({ start: T("2026-08-10T00:00:00Z"), end: T("2026-08-10T00:00:00Z") });
  });

  it("counts touching endpoints as overlapping", () => {
    expect(
      windowsOverlap(
        { start: T("2026-08-01T00:00:00Z"), end: T("2026-08-05T00:00:00Z") },
        { start: T("2026-08-05T00:00:00Z"), end: T("2026-08-09T00:00:00Z") },
      ),
    ).toBe(true);
  });

  it("reports non-overlapping windows as disjoint", () => {
    expect(
      windowsOverlap(
        { start: T("2026-08-01T00:00:00Z"), end: T("2026-08-04T00:00:00Z") },
        { start: T("2026-08-05T00:00:00Z"), end: T("2026-08-09T00:00:00Z") },
      ),
    ).toBe(false);
  });
});

describe("initiative resolution", () => {
  const index = new Map([
    ["root", { id: "root", level: "company", parentId: null, title: "Company" }],
    ["init", { id: "init", level: "initiative", parentId: "root", title: "Onboarding rewrite" }],
    ["task", { id: "task", level: "task", parentId: "init", title: "Fix the form" }],
    ["orphan", { id: "orphan", level: "task", parentId: null, title: "Loose task" }],
    ["cycleA", { id: "cycleA", level: "task", parentId: "cycleB", title: "A" }],
    ["cycleB", { id: "cycleB", level: "task", parentId: "cycleA", title: "B" }],
  ]);

  it("walks up to the nearest initiative ancestor", () => {
    expect(resolveInitiative("task", index)?.id).toBe("init");
  });

  it("returns the goal itself when it is the initiative", () => {
    expect(resolveInitiative("init", index)?.id).toBe("init");
  });

  it("falls back to the linked goal when no ancestor is an initiative", () => {
    // The vocabulary is mid-migration; the confound question does not get to
    // answer "unknown" because of that.
    expect(resolveInitiative("orphan", index)?.id).toBe("orphan");
  });

  it("returns null for a ticket with no goal", () => {
    expect(resolveInitiative(null, index)).toBeNull();
  });

  it("terminates on a cyclic parent chain", () => {
    expect(resolveInitiative("cycleA", index)?.id).toBe("cycleA");
  });
});

// --- database-backed behaviour --------------------------------------------

describeEmbeddedPostgres("release service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let svc!: ReturnType<typeof releaseService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-releases-service-");
    db = createDb(tempDb.connectionString);
    svc = releaseService(db);
  }, 40_000);

  afterEach(async () => {
    await db.delete(releaseArtifacts);
    await db.delete(releaseChanges);
    await db.delete(releases);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "FinPilot",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedInitiative(companyId: string, title: string) {
    const id = randomUUID();
    await db.insert(goals).values({ id, companyId, title, level: "initiative", status: "active" });
    return id;
  }

  async function seedIssue(
    companyId: string,
    title: string,
    goalId: string | null,
    identifier?: string,
  ) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      goalId,
      identifier: identifier ?? `T-${title.replace(/\W/g, "").slice(0, 6)}-${id.slice(0, 4)}`,
    });
    return id;
  }

  describe("creation and change attachment", () => {
    it("creates a planned release with no released_at and carries no window", async () => {
      const companyId = await seedCompany();
      const release = await svc.create(companyId, { version: "1.0.0", environment: "staging" });
      expect(release.status).toBe("planned");
      expect(release.releasedAt).toBeNull();
      expect(releaseWindow(release)).toBeNull();
    });

    it("refuses a released status without a released_at", async () => {
      const companyId = await seedCompany();
      await expect(
        svc.create(companyId, { version: "1.0.0", environment: "prod", status: "released" }),
      ).rejects.toThrow(/releasedAt is required/);
    });

    it("refuses a duplicate version in the same environment but allows it in another", async () => {
      const companyId = await seedCompany();
      await svc.create(companyId, { version: "1.0.0", environment: "staging" });
      await expect(
        svc.create(companyId, { version: "1.0.0", environment: "staging" }),
      ).rejects.toThrow(/already exists/);
      const other = await svc.create(companyId, { version: "1.0.0", environment: "prod" });
      expect(other.environment).toBe("prod");
    });

    it("attaches changes idempotently and resolves each to its initiative", async () => {
      const companyId = await seedCompany();
      const initiativeId = await seedInitiative(companyId, "Onboarding rewrite");
      const issueId = await seedIssue(companyId, "Rewrite the signup form", initiativeId, "FIN-1");
      const release = await svc.create(companyId, { version: "1.0.0", environment: "prod" });

      await svc.attachChanges(release.id, [issueId]);
      const changes = await svc.attachChanges(release.id, [issueId]);

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        issueId,
        identifier: "FIN-1",
        initiativeId,
        initiativeTitle: "Onboarding rewrite",
      });
    });

    it("refuses to attach an issue belonging to another product", async () => {
      // Cross-product attachment would silently corrupt the confound set for
      // BOTH products.
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const foreignIssue = await seedIssue(companyB, "Someone else's work", null);
      const release = await svc.create(companyA, { version: "1.0.0", environment: "prod" });
      await expect(svc.attachChanges(release.id, [foreignIssue])).rejects.toThrow(
        /do not belong to this product/,
      );
    });
  });

  describe("promotion chain", () => {
    it("promotes into a new row carrying changes and artifacts, linked both ways", async () => {
      const companyId = await seedCompany();
      const initiativeId = await seedInitiative(companyId, "Ingestion");
      const issueId = await seedIssue(companyId, "Ingest CAS statements", initiativeId);
      const dev = await svc.create(companyId, { version: "2.1.0", environment: "dev" });
      await svc.attachChanges(dev.id, [issueId]);
      await svc.addArtifact(dev.id, { repo: "sarala-ai/finpilot", tag: "v2.1.0", commitSha: "abc123def456" });

      const staging = await svc.promote(dev.id, { environment: "staging" });
      const prod = await svc.promote(staging.id, { environment: "prod" });

      expect(staging.version).toBe("2.1.0");
      expect(staging.promotedFromReleaseId).toBe(dev.id);
      expect(prod.promotedFromReleaseId).toBe(staging.id);

      const stagingDetail = await svc.detail(staging.id);
      expect(stagingDetail.changes.map((c) => c.issueId)).toEqual([issueId]);
      expect(stagingDetail.artifacts.map((a) => a.tag)).toEqual(["v2.1.0"]);
      expect(stagingDetail.promotedFrom?.id).toBe(dev.id);
      expect(stagingDetail.promotedTo.map((r) => r.id)).toEqual([prod.id]);
    });

    it("refuses promotion into the release's own environment", async () => {
      const companyId = await seedCompany();
      const dev = await svc.create(companyId, { version: "3.0.0", environment: "dev" });
      await expect(svc.promote(dev.id, { environment: "dev" })).rejects.toThrow(
        /own environment/,
      );
    });

    it("refuses to promote a rolled-back release", async () => {
      const companyId = await seedCompany();
      const dev = await svc.create(companyId, {
        version: "3.1.0",
        environment: "dev",
        status: "released",
        releasedAt: T("2026-08-01T00:00:00Z"),
      });
      await svc.close(dev.id, { closure: "rolled_back", closureReason: "checkout broke" });
      await expect(svc.promote(dev.id, { environment: "staging" })).rejects.toThrow(
        /rolled-back release cannot be promoted/,
      );
    });
  });

  describe("closure semantics", () => {
    async function shippedRelease(companyId: string, version: string) {
      return svc.create(companyId, {
        version,
        environment: "prod",
        status: "observing",
        releasedAt: T("2026-08-01T00:00:00Z"),
        observationWindowEndsAt: T("2026-08-08T00:00:00Z"),
      });
    }

    it.each(["stable", "rolled_back", "superseded", "partially_reverted"] as const)(
      "closes as %s and keeps the reason",
      async (closure) => {
        const companyId = await seedCompany();
        const release = await shippedRelease(companyId, `9.0.0-${closure}`);
        const closed = await svc.close(release.id, {
          closure,
          closureReason: `closed as ${closure}`,
        });
        expect(closed.closure).toBe(closure);
        expect(closed.closureReason).toBe(`closed as ${closure}`);
        expect(closed.closedAt).not.toBeNull();
        // status is deliberately preserved: a release that ended is still a
        // release that reached "observing".
        expect(closed.status).toBe("observing");
      },
    );

    it("refuses to close twice", async () => {
      const companyId = await seedCompany();
      const release = await shippedRelease(companyId, "9.1.0");
      await svc.close(release.id, { closure: "stable", closureReason: "no regressions" });
      await expect(
        svc.close(release.id, { closure: "rolled_back", closureReason: "changed my mind" }),
      ).rejects.toThrow(/already closed/);
    });

    it("refuses to close a release that never shipped", async () => {
      const companyId = await seedCompany();
      const release = await svc.create(companyId, { version: "9.2.0", environment: "prod" });
      await expect(
        svc.close(release.id, { closure: "stable", closureReason: "nothing happened" }),
      ).rejects.toThrow(/never shipped/);
    });

    it("refuses to edit a closed release", async () => {
      const companyId = await seedCompany();
      const release = await shippedRelease(companyId, "9.3.0");
      await svc.close(release.id, { closure: "stable", closureReason: "fine" });
      await expect(svc.update(release.id, { name: "renamed" })).rejects.toThrow(/closed release/);
    });
  });

  describe("the confound set", () => {
    async function shipped(
      companyId: string,
      version: string,
      releasedAt: string,
      windowEnd: string,
    ) {
      return svc.create(companyId, {
        version,
        environment: "prod",
        status: "observing",
        releasedAt: T(releasedAt),
        observationWindowEndsAt: T(windowEnd),
      });
    }

    it("reports a single-initiative window as clean", async () => {
      const companyId = await seedCompany();
      const initiativeId = await seedInitiative(companyId, "Onboarding rewrite");
      const issueId = await seedIssue(companyId, "Rewrite signup", initiativeId);
      const release = await shipped(companyId, "1.0.0", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z");
      await svc.attachChanges(release.id, [issueId]);

      const result = await svc.computeConfoundSet({
        companyId,
        windowStart: T("2026-08-01T00:00:00Z"),
        windowEnd: T("2026-08-08T00:00:00Z"),
        initiativeId,
      });

      expect(result.clean).toBe(true);
      expect(result.warning).toBeNull();
      expect(result.confoundingInitiatives).toEqual([]);
      expect(result.initiatives.map((i) => i.initiativeId)).toEqual([initiativeId]);
      expect(result.overlappingReleases.map((r) => r.id)).toEqual([release.id]);
    });

    it("names the other initiatives when one release carries several", async () => {
      const companyId = await seedCompany();
      const subject = await seedInitiative(companyId, "Search relevance");
      const other = await seedInitiative(companyId, "Onboarding rewrite");
      const release = await shipped(companyId, "1.1.0", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z");
      await svc.attachChanges(release.id, [
        await seedIssue(companyId, "Rerank results", subject),
        await seedIssue(companyId, "New welcome screen", other),
        await seedIssue(companyId, "Welcome copy", other),
      ]);

      const result = await svc.computeConfoundSet({
        companyId,
        windowStart: T("2026-08-01T00:00:00Z"),
        windowEnd: T("2026-08-08T00:00:00Z"),
        initiativeId: subject,
      });

      expect(result.clean).toBe(false);
      expect(result.confoundingInitiatives).toHaveLength(1);
      expect(result.confoundingInitiatives[0]).toMatchObject({
        initiativeId: other,
        initiativeTitle: "Onboarding rewrite",
        changeCount: 2,
      });
      expect(result.warning).toContain("Onboarding rewrite");
      expect(result.warning).toContain("this evidence is not clean");
    });

    it("catches an initiative shipped in a DIFFERENT but overlapping release", async () => {
      const companyId = await seedCompany();
      const subject = await seedInitiative(companyId, "Search relevance");
      const other = await seedInitiative(companyId, "Onboarding rewrite");
      const mine = await shipped(companyId, "1.2.0", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z");
      const theirs = await shipped(companyId, "1.3.0", "2026-08-04T00:00:00Z", "2026-08-11T00:00:00Z");
      await svc.attachChanges(mine.id, [await seedIssue(companyId, "Rerank", subject)]);
      await svc.attachChanges(theirs.id, [await seedIssue(companyId, "Welcome", other)]);

      const result = await svc.computeConfoundSet({
        companyId,
        windowStart: T("2026-08-01T00:00:00Z"),
        windowEnd: T("2026-08-08T00:00:00Z"),
        initiativeId: subject,
      });

      expect(result.clean).toBe(false);
      expect(result.overlappingReleases.map((r) => r.version).sort()).toEqual(["1.2.0", "1.3.0"]);
      expect(result.warning).toContain("1.3.0 (prod)");
    });

    it("ignores a release whose window does not overlap", async () => {
      const companyId = await seedCompany();
      const subject = await seedInitiative(companyId, "Search relevance");
      const other = await seedInitiative(companyId, "Onboarding rewrite");
      const mine = await shipped(companyId, "1.4.0", "2026-08-01T00:00:00Z", "2026-08-04T00:00:00Z");
      const later = await shipped(companyId, "1.5.0", "2026-08-20T00:00:00Z", "2026-08-27T00:00:00Z");
      await svc.attachChanges(mine.id, [await seedIssue(companyId, "Rerank", subject)]);
      await svc.attachChanges(later.id, [await seedIssue(companyId, "Welcome", other)]);

      const result = await svc.computeConfoundSet({
        companyId,
        windowStart: T("2026-08-01T00:00:00Z"),
        windowEnd: T("2026-08-04T00:00:00Z"),
        initiativeId: subject,
      });

      expect(result.clean).toBe(true);
      expect(result.overlappingReleases.map((r) => r.id)).toEqual([mine.id]);
    });

    it("excludes unreleased releases entirely", async () => {
      const companyId = await seedCompany();
      const subject = await seedInitiative(companyId, "Search relevance");
      const other = await seedInitiative(companyId, "Onboarding rewrite");
      const mine = await shipped(companyId, "1.6.0", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z");
      const planned = await svc.create(companyId, { version: "1.7.0", environment: "prod" });
      await svc.attachChanges(mine.id, [await seedIssue(companyId, "Rerank", subject)]);
      await svc.attachChanges(planned.id, [await seedIssue(companyId, "Welcome", other)]);

      const result = await svc.computeConfoundSet({
        companyId,
        windowStart: T("2026-08-01T00:00:00Z"),
        windowEnd: T("2026-08-08T00:00:00Z"),
        initiativeId: subject,
      });

      expect(result.clean).toBe(true);
      expect(result.overlappingReleases.map((r) => r.id)).toEqual([mine.id]);
    });

    it("never leaks another product's releases into the window", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const subject = await seedInitiative(companyA, "Search relevance");
      const otherProduct = await seedInitiative(companyB, "Bloom lessons");
      const mine = await shipped(companyA, "1.8.0", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z");
      const theirs = await shipped(companyB, "4.0.0", "2026-08-02T00:00:00Z", "2026-08-09T00:00:00Z");
      await svc.attachChanges(mine.id, [await seedIssue(companyA, "Rerank", subject)]);
      await svc.attachChanges(theirs.id, [await seedIssue(companyB, "Lessons", otherProduct)]);

      const result = await svc.computeConfoundSet({
        companyId: companyA,
        windowStart: T("2026-08-01T00:00:00Z"),
        windowEnd: T("2026-08-08T00:00:00Z"),
        initiativeId: subject,
      });

      expect(result.clean).toBe(true);
      expect(result.overlappingReleases.map((r) => r.id)).toEqual([mine.id]);
    });

    it("with no subject, calls a multi-initiative window unclean", async () => {
      const companyId = await seedCompany();
      const a = await seedInitiative(companyId, "A");
      const b = await seedInitiative(companyId, "B");
      const release = await shipped(companyId, "1.9.0", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z");
      await svc.attachChanges(release.id, [
        await seedIssue(companyId, "one", a),
        await seedIssue(companyId, "two", b),
      ]);

      const result = await svc.confoundsForRelease(release);
      expect(result.clean).toBe(false);
      expect(result.confoundingInitiatives).toHaveLength(2);
    });

    it("gives an unreleased release an empty, clean confound set", async () => {
      const companyId = await seedCompany();
      const release = await svc.create(companyId, { version: "2.0.0", environment: "prod" });
      const result = await svc.confoundsForRelease(release);
      expect(result.clean).toBe(true);
      expect(result.overlappingReleases).toEqual([]);
    });

    it("rejects a backwards query window", async () => {
      const companyId = await seedCompany();
      await expect(
        svc.computeConfoundSet({
          companyId,
          windowStart: T("2026-08-08T00:00:00Z"),
          windowEnd: T("2026-08-01T00:00:00Z"),
        }),
      ).rejects.toThrow(/windowEnd must not be before windowStart/);
    });

    it("groups changes with no goal under an unattributed bucket", async () => {
      const companyId = await seedCompany();
      const release = await shipped(companyId, "2.2.0", "2026-08-01T00:00:00Z", "2026-08-08T00:00:00Z");
      await svc.attachChanges(release.id, [await seedIssue(companyId, "Untracked fix", null)]);

      const result = await svc.confoundsForRelease(release);
      expect(result.initiatives).toEqual([
        { initiativeId: null, initiativeTitle: null, changeCount: 1, releaseIds: [release.id] },
      ]);
    });
  });

  describe("release notes projection", () => {
    it("assembles notes from the provenance chain and states the confound", async () => {
      const companyId = await seedCompany();
      const subject = await seedInitiative(companyId, "Onboarding rewrite");
      const other = await seedInitiative(companyId, "Search relevance");
      const issueA = await seedIssue(companyId, "New welcome screen", subject, "FIN-11");
      const issueB = await seedIssue(companyId, "Rerank results", other, "FIN-12");
      await db
        .update(issues)
        .set({ githubMirrorRef: "sarala-ai/finpilot#11" })
        .where(eq(issues.id, issueA));
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId: issueA,
        type: "pull_request",
        provider: "github",
        title: "Welcome screen",
        url: "https://github.com/sarala-ai/finpilot/pull/40",
        status: "merged",
      });

      const release = await svc.create(companyId, {
        version: "3.0.0",
        name: "August",
        environment: "prod",
        status: "released",
        releasedAt: T("2026-08-01T00:00:00Z"),
        observationWindowEndsAt: T("2026-08-08T00:00:00Z"),
      });
      await svc.attachChanges(release.id, [issueA, issueB]);
      await svc.addArtifact(release.id, {
        repo: "sarala-ai/finpilot",
        tag: "v3.0.0",
        commitSha: "0123456789abcdef",
      });
      await svc.addArtifact(release.id, { repo: "sarala-ai/finpilot-mobile", tag: "v3.0.0" });

      const notes = await svc.buildNotes(release.id);

      expect(notes.sections.map((s) => s.initiativeTitle)).toEqual([
        "Onboarding rewrite",
        "Search relevance",
      ]);
      expect(notes.sections[0].entries[0]).toMatchObject({
        identifier: "FIN-11",
        title: "New welcome screen",
        githubMirrorRef: "sarala-ai/finpilot#11",
        pullRequestUrls: ["https://github.com/sarala-ai/finpilot/pull/40"],
      });
      // A product release aggregates tags across every repository it spans.
      expect(notes.artifacts.map((a) => a.repo)).toEqual([
        "sarala-ai/finpilot",
        "sarala-ai/finpilot-mobile",
      ]);
      expect(notes.markdown).toContain("# 3.0.0 — August");
      expect(notes.markdown).toContain("## Onboarding rewrite");
      expect(notes.markdown).toContain("- FIN-11: New welcome screen");
      expect(notes.markdown).toContain("`sarala-ai/finpilot` `v3.0.0` @ 0123456789ab");
      // The notes state the confound rather than leaving it to be discovered.
      expect(notes.confoundWarning).toContain("this evidence is not clean");
      expect(notes.markdown).toContain("⚠️");
    });

    it("renders an empty release without inventing content", async () => {
      const companyId = await seedCompany();
      const release = await svc.create(companyId, { version: "0.1.0", environment: "dev" });
      const notes = await svc.buildNotes(release.id);
      expect(notes.sections).toEqual([]);
      expect(notes.markdown).toContain("_No changes recorded against this release._");
      expect(notes.confoundWarning).toBeNull();
    });
  });

  it("lists a product's releases newest-shipped first", async () => {
    const companyId = await seedCompany();
    await svc.create(companyId, {
      version: "1.0.0",
      environment: "prod",
      status: "released",
      releasedAt: T("2026-08-01T00:00:00Z"),
    });
    await svc.create(companyId, {
      version: "1.1.0",
      environment: "prod",
      status: "released",
      releasedAt: T("2026-08-05T00:00:00Z"),
    });
    const list = await svc.list(companyId);
    expect(list.map((r) => r.version)).toEqual(["1.1.0", "1.0.0"]);
  });
});
