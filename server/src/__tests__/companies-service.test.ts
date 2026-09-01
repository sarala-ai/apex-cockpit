import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  agentWakeupRequests,
  builtInManagedResources,
  cloudScopeBindings,
  companies,
  companySkillVersions,
  companySkills,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { updateCompanySchema } from "@paperclipai/shared";
import { companyService } from "../services/companies.js";
import { readBuiltInAgentMarker } from "../services/built-in-agent-metadata.js";
import { reconcileBuiltInAgentsOnStartup } from "../services/built-in-agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("companyService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(builtInManagedResources);
    await db.delete(companySkillVersions);
    await db.delete(companySkills);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentConfigRevisions);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(cloudScopeBindings);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("retries generated issue prefixes when Drizzle wraps the unique constraint error", async () => {
    await db.insert(companies).values({
      name: "Aron Existing",
      issuePrefix: "ARON",
    });

    const created = await companyService(db).create({
      name: "Aron & Sharon",
    });

    expect(created.issuePrefix).toBe("ARONA");

    const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
    expect(rows.map((row) => row.issuePrefix).sort()).toEqual(["ARON", "ARONA"]);
  });

  it("derives a slug from the company NAME (not the allocated issue prefix) when none is supplied at creation", async () => {
    const created = await companyService(db).create({
      name: "Aron & Sharon",
    });

    expect(created.issuePrefix).toBe("ARON");
    expect(created.slug).toBe("aronsharon");
  });

  it("preserves a 3-letter company name verbatim as the issue prefix", async () => {
    const created = await companyService(db).create({ name: "Ink" });
    expect(created.issuePrefix).toBe("INK");
    expect(created.slug).toBe("ink");
  });

  // Founder decision (issue prefixes read as names, not truncations): whole
  // cleaned name <= 5 chars is used verbatim; longer names take the first 4.
  it.each([
    ["APEX", "APEX", "apex"],
    ["Bloom", "BLOOM", "bloom"],
    ["FinPilot", "FINP", "finpilot"],
    ["Prosperity", "PROS", "prosperity"],
    ["Ab", "AB", "ab"],
  ])("derives prefix and (decoupled) slug for %s -> prefix %s, slug %s", async (name, expectedPrefix, expectedSlug) => {
    const created = await companyService(db).create({ name });
    expect(created.issuePrefix).toBe(expectedPrefix);
    expect(created.slug).toBe(expectedSlug);
  });

  it("retries a verbatim 4-letter prefix on collision the same way as any other base", async () => {
    await db.insert(companies).values({ name: "Existing Apex", issuePrefix: "APEX" });

    const created = await companyService(db).create({ name: "APEX" });

    expect(created.issuePrefix).toBe("APEXA");

    const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
    expect(rows.map((row) => row.issuePrefix).sort()).toEqual(["APEX", "APEXA"]);
  });

  it("resolves a slug collision without perturbing the (already-unique) derived prefix", async () => {
    // Existing company happens to have the slug "finpilot" already, under a
    // completely different issue prefix — only the slug axis collides.
    await db.insert(companies).values({ name: "Some Other Co", issuePrefix: "ZZZZ", slug: "finpilot" });

    const created = await companyService(db).create({ name: "FinPilot" });

    expect(created.issuePrefix).toBe("FINP");
    expect(created.slug).toBe("finpilot-2");
  });

  it("resolves a prefix collision without perturbing the (already-unique) derived slug", async () => {
    // Existing company happens to have the issue prefix "FINP" already, under
    // a completely different slug — only the prefix axis collides.
    await db.insert(companies).values({ name: "Some Other Co", issuePrefix: "FINP", slug: "something-else" });

    const created = await companyService(db).create({ name: "FinPilot" });

    expect(created.issuePrefix).toBe("FINPA");
    expect(created.slug).toBe("finpilot");
  });

  it("falls back to a co-prefixed slug when the cleaned name can't stand alone (digit-leading)", async () => {
    const created = await companyService(db).create({ name: "123 Inc" });
    // "123 Inc" -> cleaned "123inc" starts with a digit, which
    // companySlugSchema rejects (must start with a letter) — the fallback
    // prepends "co-" so the slug is still derived purely from the name.
    expect(created.slug).toBe("co-123inc");
  });

  it("falls back to a co-prefixed slug when the cleaned name is a single character", async () => {
    const created = await companyService(db).create({ name: "A" });
    // "A" -> cleaned "a" is only 1 character, below companySlugSchema's
    // 2-character minimum.
    expect(created.slug).toBe("co-a");
  });

  it("accepts an explicit slug at creation", async () => {
    const created = await companyService(db).create({
      name: "Aron & Sharon",
      slug: "custom-slug",
    });

    expect(created.slug).toBe("custom-slug");
  });

  it("rejects creation with a slug already used by another company", async () => {
    await db.insert(companies).values({
      name: "Existing Co",
      issuePrefix: "EXC",
      slug: "taken",
    });

    await expect(
      companyService(db).create({ name: "New Co", slug: "taken" }),
    ).rejects.toMatchObject({ status: 409, details: { code: "slug_conflict" } });
  });

  it("accepts an explicit issuePrefix at creation, winning over derivation", async () => {
    const created = await companyService(db).create({
      name: "Totally Unrelated Name",
      issuePrefix: "CUSTOM",
    });

    expect(created.issuePrefix).toBe("CUSTOM");
    // Slug still derives — from the NAME (the two axes are independent), not
    // from the explicit prefix — since no slug was supplied.
    expect(created.slug).toBe("totallyunrelatedname");
  });

  it("honors both an explicit issuePrefix and an explicit slug together", async () => {
    const created = await companyService(db).create({
      name: "Whatever",
      issuePrefix: "CUSTOM",
      slug: "custom-slug",
    });

    expect(created.issuePrefix).toBe("CUSTOM");
    expect(created.slug).toBe("custom-slug");
  });

  it("rejects creation with an explicit issuePrefix already used by another company, without silently appending a suffix", async () => {
    await db.insert(companies).values({ name: "Existing", issuePrefix: "TAKEN" });

    await expect(
      companyService(db).create({ name: "New Co", issuePrefix: "TAKEN" }),
    ).rejects.toMatchObject({ status: 409, details: { code: "issue_prefix_conflict" } });

    // Confirms no "TAKENA"-style silent retry happened.
    const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies);
    expect(rows.map((row) => row.issuePrefix)).toEqual(["TAKEN"]);
  });

  describe("identityPreview", () => {
    it("returns the derived prefix/slug (independent axes) and marks them available when nothing collides", async () => {
      const result = await companyService(db).identityPreview("Acme Corp");

      expect(result).toEqual({
        name: "Acme Corp",
        issuePrefix: "ACME",
        slug: "acmecorp",
        prefixAvailable: true,
        slugAvailable: true,
        suggestedPrefix: null,
        suggestedSlug: null,
      });
    });

    it("preserves a short name verbatim, mirroring create()'s own derivation", async () => {
      const result = await companyService(db).identityPreview("APEX");
      expect(result.issuePrefix).toBe("APEX");
      expect(result.slug).toBe("apex");
    });

    it("reports the derived prefix as unavailable when taken, with a colliding-free suggestion, without perturbing an available slug", async () => {
      // Prefix axis collides; slug does not (a completely different slug).
      await db.insert(companies).values({ name: "Existing Apex", issuePrefix: "APEX", slug: "something-else" });

      const result = await companyService(db).identityPreview("APEX");

      expect(result.prefixAvailable).toBe(false);
      expect(result.slugAvailable).toBe(true);
      expect(result.suggestedPrefix).toBe("APEXA");
      expect(result.suggestedSlug).toBeNull();
    });

    it("reports the derived slug as unavailable when taken, with a colliding-free suggestion, without perturbing an available prefix", async () => {
      // Slug axis collides; prefix does not (a completely different prefix).
      await db.insert(companies).values({ name: "Some Other Co", issuePrefix: "ZZZZ", slug: "apex" });

      const result = await companyService(db).identityPreview("APEX");

      expect(result.prefixAvailable).toBe(true);
      expect(result.slugAvailable).toBe(false);
      expect(result.suggestedPrefix).toBeNull();
      expect(result.suggestedSlug).toBe("apex-2");
    });

    it("checks an operator-supplied prefix override independently of the (still name-derived) slug", async () => {
      await db.insert(companies).values({ name: "Existing", issuePrefix: "CUSTOM", slug: "custom" });

      const result = await companyService(db).identityPreview("Acme Corp", { issuePrefix: "CUSTOM" });

      expect(result.issuePrefix).toBe("CUSTOM");
      expect(result.prefixAvailable).toBe(false);
      // Slug still derives from the NAME (not the override prefix) — the two
      // axes stay independent even when one is overridden.
      expect(result.slug).toBe("acmecorp");
      expect(result.slugAvailable).toBe(true);
    });

    it("returns an all-unavailable, empty-string preview for a blank name without querying the database", async () => {
      const result = await companyService(db).identityPreview("   ");

      expect(result).toEqual({
        name: "",
        issuePrefix: "",
        slug: "",
        prefixAvailable: false,
        slugAvailable: false,
        suggestedPrefix: null,
        suggestedSlug: null,
      });
    });

    it("never drifts from create()'s own allocation for the same name", async () => {
      const previewed = await companyService(db).identityPreview("FinPilot");
      const created = await companyService(db).create({ name: "FinPilot" });

      expect(created.issuePrefix).toBe(previewed.issuePrefix);
      expect(created.slug).toBe(previewed.slug);
    });
  });

  it("sets slug once when the current value is null (legacy un-backfilled company)", async () => {
    const companyId = randomUUID();
    // Simulate a company created before the slug column/backfill existed by
    // inserting directly, bypassing the service (which always derives a slug
    // at creation).
    await db.insert(companies).values({
      id: companyId,
      name: "Null Slug Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      slug: null,
    });

    const updated = await companyService(db).update(
      companyId,
      { slug: "Now-Set" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(updated?.slug).toBe("now-set");
  });

  it("rejects any update to a company slug once it is already set, even to the same value", async () => {
    const created = await companyService(db).create({
      name: "Sluggish Co",
    });
    expect(created.slug).toBeTruthy();

    await expect(
      companyService(db).update(
        created.id,
        { slug: "different-slug" },
        { actorType: "user", actorId: "test-user", agentId: null, runId: null },
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: "slug_immutable" } });

    await expect(
      companyService(db).update(
        created.id,
        { slug: created.slug! },
        { actorType: "user", actorId: "test-user", agentId: null, runId: null },
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: "slug_immutable" } });

    const rows = await db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, created.id));
    expect(rows[0]?.slug).toBe(created.slug);
  });

  it("rejects setting a null slug to a value already used by another company", async () => {
    await db.insert(companies).values({
      name: "Other Co",
      issuePrefix: "OTC",
      slug: "already-used",
    });
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Null Slug Co Two",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      slug: null,
    });

    await expect(
      companyService(db).update(
        companyId,
        { slug: "already-used" },
        { actorType: "user", actorId: "test-user", agentId: null, runId: null },
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: "slug_conflict" } });
  });

  describe("breakGlassChangeSlug", () => {
    const actor = { actorType: "user" as const, actorId: "test-admin", agentId: null, runId: null };

    it("returns a consequences preview without writing when confirm is absent", async () => {
      const created = await companyService(db).create({ name: "Preview Co" });
      const result = await companyService(db).breakGlassChangeSlug(created.id, "new-alias", { actor });

      expect(result.preview).toBe(true);
      expect(result.consequences).toMatchObject({
        companyId: created.id,
        currentSlug: created.slug,
        proposedSlug: "new-alias",
      });
      expect(result.consequences.envVarsThatChange.length).toBeGreaterThan(0);
      expect(result.consequences.capabilitySyncTargets.length).toBeGreaterThan(0);
      expect(result.company).toBeUndefined();

      const rows = await db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, created.id));
      expect(rows[0]?.slug).toBe(created.slug);
    });

    it("still validates the shape of the new slug on preview", async () => {
      const created = await companyService(db).create({ name: "Bad Slug Co" });
      await expect(
        companyService(db).breakGlassChangeSlug(created.id, "Not Valid!", { actor }),
      ).rejects.toMatchObject({ status: 422, details: { code: "slug_invalid" } });
    });

    it("rejects break-glass on a company whose slug was never set", async () => {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Never Slugged Co",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        slug: null,
      });

      await expect(
        companyService(db).breakGlassChangeSlug(companyId, "whatever", { actor }),
      ).rejects.toMatchObject({ status: 422, details: { code: "slug_break_glass_not_set" } });
    });

    it("rejects execution when confirm does not match the current slug", async () => {
      const created = await companyService(db).create({ name: "Mismatch Co" });
      await expect(
        companyService(db).breakGlassChangeSlug(created.id, "new-alias", {
          confirm: "wrong-slug",
          actor,
        }),
      ).rejects.toMatchObject({ status: 409, details: { code: "slug_break_glass_confirm_mismatch" } });

      const rows = await db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, created.id));
      expect(rows[0]?.slug).toBe(created.slug);
    });

    it("performs the change transactionally and records an audit entry with the consequences snapshot when confirm matches the current slug", async () => {
      const created = await companyService(db).create({ name: "Confirmed Co" });
      const oldSlug = created.slug!;

      const result = await companyService(db).breakGlassChangeSlug(created.id, "brand-new-alias", {
        confirm: oldSlug,
        actor,
      });

      expect(result.preview).toBe(false);
      expect(result.company?.slug).toBe("brand-new-alias");
      expect(result.consequences.currentSlug).toBe(oldSlug);
      expect(result.consequences.proposedSlug).toBe("brand-new-alias");
      expect(result.activityId).toBeTruthy();

      const rows = await db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, created.id));
      expect(rows[0]?.slug).toBe("brand-new-alias");

      const [logRow] = await db
        .select({
          action: activityLog.action,
          actorId: activityLog.actorId,
          details: activityLog.details,
        })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, created.id), eq(activityLog.action, "company.slug_break_glass")));

      expect(logRow).toMatchObject({
        action: "company.slug_break_glass",
        actorId: "test-admin",
      });
      expect(logRow?.details).toMatchObject({
        oldSlug,
        newSlug: "brand-new-alias",
        consequences: { currentSlug: oldSlug, proposedSlug: "brand-new-alias" },
      });
    });

    it("rejects executing a conflicting slug already used by another company", async () => {
      await db.insert(companies).values({ name: "Taken Co", issuePrefix: "TKC", slug: "taken-alias" });
      const created = await companyService(db).create({ name: "Conflicted Co" });

      await expect(
        companyService(db).breakGlassChangeSlug(created.id, "taken-alias", {
          confirm: created.slug!,
          actor,
        }),
      ).rejects.toMatchObject({ status: 409, details: { code: "slug_conflict" } });
    });

    it("lists bound repos in the consequences report so the operator knows which committed configs go stale", async () => {
      const created = await companyService(db).create({ name: "Bound Repo Co" });
      await db.insert(cloudScopeBindings).values({
        scopeType: "company",
        scopeId: created.id,
        githubRepos: ["acme/finpilot", "acme/bloom"],
      });

      const result = await companyService(db).breakGlassChangeSlug(created.id, "new-alias-2", { actor });
      expect(result.consequences.boundRepoConfigs.map((r) => r.repo)).toEqual(["acme/finpilot", "acme/bloom"]);
      expect(result.consequences.warning).toContain("bound repo");
    });

    it("never allows a break-glass change through the normal update() path", async () => {
      const created = await companyService(db).create({ name: "Normal Path Co" });
      await expect(
        companyService(db).update(
          created.id,
          { slug: "sneaky" },
          { actorType: "user", actorId: "test-user", agentId: null, runId: null },
        ),
      ).rejects.toMatchObject({ status: 409, details: { code: "slug_immutable" } });
    });
  });

  describe("breakGlassChangeIssuePrefix", () => {
    const actor = { actorType: "user" as const, actorId: "test-admin", agentId: null, runId: null };

    it("returns a consequences preview without writing when confirm is absent", async () => {
      const created = await companyService(db).create({ name: "Preview Prefix Co" });
      const result = await companyService(db).breakGlassChangeIssuePrefix(created.id, "NEWP", { actor });

      expect(result.preview).toBe(true);
      expect(result.consequences).toMatchObject({
        companyId: created.id,
        currentPrefix: created.issuePrefix,
        proposedPrefix: "NEWP",
        existingIssueCount: 0,
      });
      expect(result.company).toBeUndefined();

      const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, created.id));
      expect(rows[0]?.issuePrefix).toBe(created.issuePrefix);
    });

    it("still validates the shape of the new prefix on preview", async () => {
      const created = await companyService(db).create({ name: "Bad Prefix Co" });
      await expect(
        companyService(db).breakGlassChangeIssuePrefix(created.id, "not valid!", { actor }),
      ).rejects.toMatchObject({ status: 422, details: { code: "issue_prefix_invalid" } });
    });

    it("rejects execution when confirm does not match the current prefix", async () => {
      const created = await companyService(db).create({ name: "Mismatch Prefix Co" });
      await expect(
        companyService(db).breakGlassChangeIssuePrefix(created.id, "NEWP", {
          confirm: "wrong-prefix",
          actor,
        }),
      ).rejects.toMatchObject({ status: 409, details: { code: "issue_prefix_break_glass_confirm_mismatch" } });

      const rows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, created.id));
      expect(rows[0]?.issuePrefix).toBe(created.issuePrefix);
    });

    it("performs the change transactionally, rewrites existing issue identifiers, and records an audit entry", async () => {
      const created = await companyService(db).create({ name: "Confirmed Prefix Co" });
      const oldPrefix = created.issuePrefix;

      // Simulate a couple of existing issues under the old prefix, the way
      // issues.ts would have created them (identifier built from prefix + the
      // stored issueNumber column).
      await db.insert(issues).values([
        {
          companyId: created.id,
          title: "First",
          status: "open",
          issueNumber: 1,
          identifier: `${oldPrefix}-1`,
        },
        {
          companyId: created.id,
          title: "Second",
          status: "open",
          issueNumber: 2,
          identifier: `${oldPrefix}-2`,
        },
      ]);

      const result = await companyService(db).breakGlassChangeIssuePrefix(created.id, "CFPX", {
        confirm: oldPrefix,
        actor,
      });

      expect(result.preview).toBe(false);
      expect(result.company?.issuePrefix).toBe("CFPX");
      expect(result.consequences.currentPrefix).toBe(oldPrefix);
      expect(result.consequences.proposedPrefix).toBe("CFPX");
      expect(result.consequences.existingIssueCount).toBe(2);
      expect(result.activityId).toBeTruthy();

      const companyRows = await db.select({ issuePrefix: companies.issuePrefix }).from(companies).where(eq(companies.id, created.id));
      expect(companyRows[0]?.issuePrefix).toBe("CFPX");

      const issueRows = await db
        .select({ identifier: issues.identifier, issueNumber: issues.issueNumber })
        .from(issues)
        .where(eq(issues.companyId, created.id))
        .orderBy(issues.issueNumber);
      expect(issueRows).toEqual([
        { identifier: "CFPX-1", issueNumber: 1 },
        { identifier: "CFPX-2", issueNumber: 2 },
      ]);

      const [logRow] = await db
        .select({ action: activityLog.action, actorId: activityLog.actorId, details: activityLog.details })
        .from(activityLog)
        .where(and(eq(activityLog.companyId, created.id), eq(activityLog.action, "company.issue_prefix_break_glass")));

      expect(logRow).toMatchObject({ action: "company.issue_prefix_break_glass", actorId: "test-admin" });
      expect(logRow?.details).toMatchObject({
        oldPrefix,
        newPrefix: "CFPX",
        consequences: { currentPrefix: oldPrefix, proposedPrefix: "CFPX", existingIssueCount: 2 },
      });
    });

    it("rejects executing a conflicting prefix already used by another company", async () => {
      await db.insert(companies).values({ name: "Taken Prefix Co", issuePrefix: "TAKN" });
      const created = await companyService(db).create({ name: "Conflicted Prefix Co" });

      await expect(
        companyService(db).breakGlassChangeIssuePrefix(created.id, "TAKN", {
          confirm: created.issuePrefix,
          actor,
        }),
      ).rejects.toMatchObject({ status: 409, details: { code: "issue_prefix_conflict" } });
    });

    it("reports a purely forward-looking warning when the company has no existing issues", async () => {
      const created = await companyService(db).create({ name: "Empty Prefix Co" });
      const result = await companyService(db).breakGlassChangeIssuePrefix(created.id, "EMPT", { actor });
      expect(result.consequences.existingIssueCount).toBe(0);
      expect(result.consequences.warning).toContain("forward-looking");
    });

    it("flags stale GitHub mirror issue titles when GitHub projection is enabled", async () => {
      const created = await companyService(db).create({ name: "Projected Prefix Co" });
      await companyService(db).update(
        created.id,
        { githubProjectionEnabled: true, githubProjectionRepo: "acme/projected-prefix-co" },
        actor,
      );

      const result = await companyService(db).breakGlassChangeIssuePrefix(created.id, "PROJ", { actor });
      expect(result.consequences.githubProjectionRepo).toBe("acme/projected-prefix-co");
      expect(result.consequences.warning).toContain("GitHub projection");
    });

    it("keeps issuePrefix out of the normal HTTP update() request shape — break-glass is the only route in", () => {
      // The HTTP PATCH /:companyId route always parses the body through
      // updateCompanySchema (or updateCompanyBrandingSchema for agents)
      // before it ever reaches companyService.update — see
      // server/src/routes/companies.ts. As long as issuePrefix is absent
      // from that schema, an operator (or agent) can never rewrite the
      // prefix — and silently orphan/duplicate issue identifiers — through
      // the ordinary settings PATCH; the audited break-glass route above is
      // the only path in. This guards the schema shape directly rather than
      // the service layer, which (like slug pre-immutability-check) still
      // trusts its caller.
      expect(Object.prototype.hasOwnProperty.call(updateCompanySchema.shape, "issuePrefix")).toBe(false);
    });
  });

  /**
   * A freshly created company arrives carrying THE ROSTER and nothing else.
   *
   * This used to assert the inherited reflection-coach bundle, which was
   * auto-provisioned into every new company despite no lifecycle commissioning
   * it. The property under test is unchanged — creation provisions the
   * definitions that ask to exist, exactly once, and a startup reconcile does
   * not double them — but the subject is now the four agents this product
   * actually commissions.
   */
  it("auto-provisions exactly the roster for a freshly created company", async () => {
    const created = await companyService(db).create({
      name: "Fresh Company",
    });

    const agentRows = await db.select().from(agents).where(eq(agents.companyId, created.id));
    const builtInKeys = agentRows
      .map((row) => readBuiltInAgentMarker(row.metadata)?.key)
      .filter((key): key is string => Boolean(key))
      .sort();
    expect(builtInKeys).toEqual(["design-engineer", "implementer", "product-assistant", "specifier"]);

    const [assistantRow] = agentRows.filter(
      (row) => readBuiltInAgentMarker(row.metadata)?.key === "product-assistant",
    );
    expect(assistantRow).toMatchObject({
      name: "Product Assistant",
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
    });

    // No roster agent ships a bundled skill, so company creation must not
    // install one on the company's behalf.
    const skillRows = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, created.id));
    expect(skillRows).toHaveLength(0);

    // The one bundled routine on the roster, paused and unscheduled.
    const [routine] = await db.select().from(routines).where(eq(routines.companyId, created.id));
    expect(routine).toMatchObject({
      status: "paused",
      assigneeAgentId: assistantRow!.id,
      originKind: "built_in_agent_bundle",
      originId: "product-assistant:reconstruct-initiatives",
    });
    const [trigger] = await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routine!.id));
    expect(trigger).toMatchObject({
      kind: "schedule",
      enabled: false,
    });

    await reconcileBuiltInAgentsOnStartup(db);
    const afterReconcileRows = await db.select().from(agents).where(eq(agents.companyId, created.id));
    expect(
      afterReconcileRows
        .map((row) => readBuiltInAgentMarker(row.metadata)?.key)
        .filter((key): key is string => Boolean(key))
        .sort(),
    ).toEqual(builtInKeys);
  });

  it("archives companies by pausing runnable agents and cancelling active runs", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const errorAgentId = randomUUID();
    const pausedAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const terminatedAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: errorAgentId,
        companyId,
        name: "Error Agent",
        role: "engineer",
        status: "error",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pausedAgentId,
        companyId,
        name: "Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: terminatedAgentId,
        companyId,
        name: "Terminated Agent",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: runningAgentId,
      source: "timer",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: runningAgentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId,
    });

    const archived = await companyService(db).archive(companyId, {
      actorType: "user",
      actorId: "test-user",
      agentId: null,
      runId: null,
    });

    expect(archived?.status).toBe("archived");

    const archiveActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsPaused: 3, runsCancelled: 1 },
    });

    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        pauseReason: agents.pauseReason,
      })
      .from(agents);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(errorAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(pausedAgentId)).toMatchObject({ status: "paused", pauseReason: "manual" });
    expect(byId.get(pendingAgentId)).toMatchObject({ status: "pending_approval", pauseReason: null });
    expect(byId.get(terminatedAgentId)).toMatchObject({ status: "terminated", pauseReason: null });

    const run = await db
      .select({
        status: heartbeatRuns.status,
        error: heartbeatRuns.error,
      })
      .from(heartbeatRuns)
      .then((result) => result[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });

    const wakeup = await db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .then((result) => result[0] ?? null);
    expect(wakeup).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
  });

  it("reactivates only agents paused because the company was archived", async () => {
    const companyId = randomUUID();
    const archivedPausedAgentId = randomUUID();
    const manualPausedAgentId = randomUUID();
    const pendingAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Reactivate Test Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: archivedPausedAgentId,
        companyId,
        name: "Archived Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: manualPausedAgentId,
        companyId,
        name: "Manual Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Approval Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsRestored: 1 },
    });

    const rows = await db
      .select({
        id: agents.id,
        status: agents.status,
        pauseReason: agents.pauseReason,
        pausedAt: agents.pausedAt,
      })
      .from(agents);

    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archivedPausedAgentId)).toMatchObject({
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    expect(byId.get(manualPausedAgentId)).toMatchObject({
      status: "paused",
      pauseReason: "manual",
    });
    expect(byId.get(pendingAgentId)).toMatchObject({
      status: "pending_approval",
      pauseReason: null,
    });
  });

  it("runs the archive cascade when update() transitions a company to archived", async () => {
    const companyId = randomUUID();
    const runningAgentId = randomUUID();
    const idleAgentId = randomUUID();
    const pendingAgentId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Update Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: runningAgentId,
        companyId,
        name: "Running Agent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: idleAgentId,
        companyId,
        name: "Idle Agent",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: pendingAgentId,
        companyId,
        name: "Pending Agent",
        role: "engineer",
        status: "pending_approval",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: runningAgentId,
      source: "timer",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: runningAgentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId,
    });

    const archived = await companyService(db).update(
      companyId,
      { status: "archived" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(archived?.status).toBe("archived");

    const rows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(runningAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(idleAgentId)).toMatchObject({ status: "paused", pauseReason: "company_archived" });
    expect(byId.get(pendingAgentId)).toMatchObject({ status: "pending_approval", pauseReason: null });

    const run = await db
      .select({ status: heartbeatRuns.status, error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .then((result) => result[0] ?? null);
    expect(run).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });

    const archiveActivity = await db
      .select({
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      actorType: "user",
      actorId: "test-user",
      details: { agentsPaused: 2, runsCancelled: 1 },
    });
  });

  it("reactivates company_archived agents even when going via paused state (archived → paused → active)", async () => {
    const companyId = randomUUID();
    const archivedPausedAgentId = randomUUID();
    const manualPausedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Indirect Reactivate Test Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: archivedPausedAgentId,
        companyId,
        name: "Archived Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "company_archived",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: manualPausedAgentId,
        companyId,
        name: "Manual Paused Agent",
        role: "engineer",
        status: "paused",
        pauseReason: "manual",
        pausedAt: new Date("2026-06-01T00:00:00Z"),
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const rows = await db
      .select({ id: agents.id, status: agents.status, pauseReason: agents.pauseReason })
      .from(agents);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(archivedPausedAgentId)).toMatchObject({ status: "idle", pauseReason: null });
    expect(byId.get(manualPausedAgentId)).toMatchObject({ status: "paused", pauseReason: "manual" });

    const reactivateActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({ details: { agentsRestored: 1 } });
  });

  it("emits company.reactivated for archived → active even when no agents need restoring", async () => {
    const companyId = randomUUID();
    const terminatedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Empty Reactivate Co",
      status: "archived",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: terminatedAgentId,
      companyId,
      name: "Terminated Agent",
      role: "engineer",
      status: "terminated",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(1);
    expect(reactivateActivity[0]).toMatchObject({ details: { agentsRestored: 0 } });
  });

  it("does not emit company.reactivated when paused → active restores no archive-paused agents", async () => {
    const companyId = randomUUID();
    const manualPausedAgentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Plain Unpause Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: manualPausedAgentId,
      companyId,
      name: "Manual Paused Agent",
      role: "engineer",
      status: "paused",
      pauseReason: "manual",
      pausedAt: new Date("2026-06-01T00:00:00Z"),
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const reactivated = await companyService(db).update(
      companyId,
      { status: "active" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(reactivated?.status).toBe("active");

    const reactivateActivity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.reactivated"),
      ));
    expect(reactivateActivity).toHaveLength(0);

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .then((rows) => rows[0] ?? null);
    expect(agent).toMatchObject({ status: "paused", pauseReason: "manual" });
  });

  it("cancels orphan queued wakeup requests with no runId during archive", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const orphanWakeupId = randomUUID();
    const runWakeupId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Orphan Wakeup Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(agentWakeupRequests).values([
      {
        id: orphanWakeupId,
        companyId,
        agentId,
        source: "automation",
        status: "queued",
      },
      {
        id: runWakeupId,
        companyId,
        agentId,
        source: "timer",
        status: "queued",
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "timer",
      status: "running",
      wakeupRequestId: runWakeupId,
    });

    const archived = await companyService(db).archive(companyId, {
      actorType: "user",
      actorId: "test-user",
      agentId: null,
      runId: null,
    });
    expect(archived?.status).toBe("archived");

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests);
    const byId = new Map(wakeups.map((row) => [row.id, row]));
    expect(byId.get(orphanWakeupId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
    expect(byId.get(runWakeupId)).toMatchObject({
      status: "cancelled",
      error: "Cancelled because the company was archived",
    });
  });

  it("archive() is idempotent — re-archiving emits no second cascade or activity entry", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Idempotent Archive Test Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const actor = { actorType: "user" as const, actorId: "test-user", agentId: null, runId: null };
    const first = await companyService(db).archive(companyId, actor);
    expect(first?.status).toBe("archived");

    const second = await companyService(db).archive(companyId, actor);
    expect(second?.status).toBe("archived");

    const archiveActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({ details: { agentsPaused: 1, runsCancelled: 0 } });
  });

  it("runs the archive cascade when update() transitions a paused company to archived", async () => {
    const companyId = randomUUID();
    const idleAgentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paused To Archived Test Co",
      status: "paused",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: idleAgentId,
      companyId,
      name: "Idle Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: idleAgentId,
      invocationSource: "timer",
      status: "queued",
    });

    const archived = await companyService(db).update(
      companyId,
      { status: "archived" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );

    expect(archived?.status).toBe("archived");

    const agent = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason })
      .from(agents)
      .then((rows) => rows[0] ?? null);
    expect(agent).toMatchObject({ status: "paused", pauseReason: "company_archived" });

    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("cancelled");

    const archiveActivity = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "company.archived"),
      ));
    expect(archiveActivity).toHaveLength(1);
    expect(archiveActivity[0]).toMatchObject({
      details: { agentsPaused: 1, runsCancelled: 1 },
    });
  });

  it("github projection is off by default, can be enabled with no fallback repo, and round-trips", async () => {
    const created = await companyService(db).create({ name: "Projection Co" });
    expect(created.githubProjectionEnabled).toBe(false);
    expect(created.githubProjectionRepo).toBeNull();

    // Enabling with no fallback repo (neither in the patch nor stored) is now
    // legitimate: mirror targeting is primarily the per-ticket project
    // workspace cascade, and the company repo is only a fallback for tickets
    // with no repo-bearing project binding.
    const enabledNoRepo = await companyService(db).update(
      created.id,
      { githubProjectionEnabled: true },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );
    expect(enabledNoRepo?.githubProjectionEnabled).toBe(true);
    expect(enabledNoRepo?.githubProjectionRepo).toBeNull();

    const enabled = await companyService(db).update(
      created.id,
      { githubProjectionEnabled: true, githubProjectionRepo: "sarala-ai/apex" },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );
    expect(enabled?.githubProjectionEnabled).toBe(true);
    expect(enabled?.githubProjectionRepo).toBe("sarala-ai/apex");

    // Enabling later with the repo already stored is fine.
    const disabled = await companyService(db).update(
      created.id,
      { githubProjectionEnabled: false },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );
    expect(disabled?.githubProjectionEnabled).toBe(false);
    const reEnabled = await companyService(db).update(
      created.id,
      { githubProjectionEnabled: true },
      { actorType: "user", actorId: "test-user", agentId: null, runId: null },
    );
    expect(reEnabled?.githubProjectionEnabled).toBe(true);
    expect(reEnabled?.githubProjectionRepo).toBe("sarala-ai/apex");
  });
});
