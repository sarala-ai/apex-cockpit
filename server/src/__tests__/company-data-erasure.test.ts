/**
 * COMPANY DATA ERASURE — against a real Postgres, because the whole risk here
 * is in the constraints.
 *
 * The single most important assertion in this file is the one that seeds TWO
 * companies with identical data and checks the second is byte-for-byte
 * untouched after each of the three scopes runs against the first. Every delete
 * this service issues carries a `company_id` predicate in the statement itself
 * rather than filtering a prior read, and that promise is only worth anything
 * if something checks it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  goals,
  issues,
  labels,
  projectGoals,
  projects,
  proposals,
} from "@paperclipai/db";
import { DATA_ERASURE_ACTIVITY_ACTION } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyDataErasureService } from "../services/company-data-erasure.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(
    `Skipping embedded Postgres company-data-erasure tests on this host: ${support.reason ?? "unsupported environment"}`,
  );
}

const ACTOR = {
  actorType: "user" as const,
  actorId: "owner-user",
  agentId: null,
  runId: null,
};

describeDb("company data erasure", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let service!: ReturnType<typeof companyDataErasureService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("company-data-erasure-");
    db = createDb(tempDb.connectionString);
    service = companyDataErasureService(db);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * One company with the shape the real board has: initiatives with projects
   * attached both ways the schema allows, issues under those projects, an
   * agent, a proposal, a cost event, a label, and a membership.
   */
  async function seedCompany(suffix: string) {
    const [company] = await db
      .insert(companies)
      .values({
        name: `Company ${suffix}`,
        slug: `company-${suffix}`,
        issuePrefix: `T${suffix.toUpperCase().slice(0, 3)}`,
      })
      .returning();

    const [agent] = await db
      .insert(agents)
      .values({ companyId: company.id, name: `Agent ${suffix}` })
      .returning();

    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "owner-user",
      status: "active",
      membershipRole: "owner",
    });

    await db.insert(labels).values({ companyId: company.id, name: `label-${suffix}`, color: "#888888" });

    const [initiativeA] = await db
      .insert(goals)
      .values({ companyId: company.id, title: `Initiative A ${suffix}`, level: "initiative" })
      .returning();
    const [initiativeB] = await db
      .insert(goals)
      .values({ companyId: company.id, title: `Initiative B ${suffix}`, level: "initiative" })
      .returning();
    // A sub-goal beneath an initiative — it cannot outlive its parent.
    const [subGoal] = await db
      .insert(goals)
      .values({ companyId: company.id, title: `Sub ${suffix}`, level: "task", parentId: initiativeA.id })
      .returning();
    // A goal that is NOT under any initiative: it must survive the
    // `initiatives` scope untouched.
    const [looseGoal] = await db
      .insert(goals)
      .values({ companyId: company.id, title: `Loose ${suffix}`, level: "team" })
      .returning();

    // Attached by the direct FK…
    const [projectA] = await db
      .insert(projects)
      .values({ companyId: company.id, name: `Project A ${suffix}`, goalId: initiativeA.id })
      .returning();
    // …and by the many-to-many link table.
    const [projectB] = await db
      .insert(projects)
      .values({ companyId: company.id, name: `Project B ${suffix}` })
      .returning();
    await db.insert(projectGoals).values({
      companyId: company.id,
      projectId: projectB.id,
      goalId: initiativeB.id,
    });
    // Attached to nothing — survives the `initiatives` scope, dies with `projects`.
    const [projectC] = await db
      .insert(projects)
      .values({ companyId: company.id, name: `Project C ${suffix}` })
      .returning();

    const [issueA] = await db
      .insert(issues)
      .values({ companyId: company.id, title: `Issue A ${suffix}`, projectId: projectA.id })
      .returning();
    const [issueChild] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: `Issue child ${suffix}`,
        projectId: projectA.id,
        parentId: issueA.id,
      })
      .returning();
    // Points at an initiative goal but sits in no project.
    const [issueOnGoal] = await db
      .insert(issues)
      .values({ companyId: company.id, title: `Issue on goal ${suffix}`, goalId: initiativeB.id })
      .returning();

    await db.insert(proposals).values({
      companyId: company.id,
      kind: "initiatives",
      title: `Proposal ${suffix}`,
    });

    const [cost] = await db
      .insert(costEvents)
      .values({
        companyId: company.id,
        agentId: agent.id,
        goalId: initiativeA.id,
        projectId: projectA.id,
        issueId: issueA.id,
        provider: "test",
        model: "test-model",
        costCents: 500,
        occurredAt: new Date(),
      })
      .returning();

    return {
      company,
      agent,
      initiativeA,
      initiativeB,
      subGoal,
      looseGoal,
      projectA,
      projectB,
      projectC,
      issueA,
      issueChild,
      issueOnGoal,
      cost,
    };
  }

  async function countFor(table: typeof issues | typeof goals | typeof projects | typeof agents | typeof proposals | typeof labels | typeof companyMemberships, companyId: string) {
    const rows = await db.select().from(table as never).where(eq((table as never as { companyId: never }).companyId, companyId as never));
    return rows.length;
  }

  afterEach(async () => {
    // Truncate the whole graph between cases; the erasure under test must never
    // be the thing that cleans up after itself.
    await db.execute(
      `truncate table cost_events, finance_events, activity_log, proposals, issues, project_goals, projects, goals, agents, labels, company_memberships, companies restart identity cascade` as never,
    );
  });

  // ─── the isolation test ────────────────────────────────────────────────────

  it("never crosses a company boundary — any scope", async () => {
    for (const scope of ["company", "projects", "initiatives"] as const) {
      const target = await seedCompany("target");
      const bystander = await seedCompany("bystander");

      const before = {
        issues: await countFor(issues, bystander.company.id),
        goals: await countFor(goals, bystander.company.id),
        projects: await countFor(projects, bystander.company.id),
        agents: await countFor(agents, bystander.company.id),
        proposals: await countFor(proposals, bystander.company.id),
        labels: await countFor(labels, bystander.company.id),
      };
      expect(before.issues).toBeGreaterThan(0);
      expect(before.goals).toBeGreaterThan(0);
      expect(before.projects).toBeGreaterThan(0);

      const report = await service.erase(
        target.company.id,
        { scope, children: "cascade", confirm: target.company.slug! },
        ACTOR,
      );
      expect(report.dryRun).toBe(false);
      expect(report.blocked).toBeNull();
      expect(report.totalRowsDeleted).toBeGreaterThan(0);

      const after = {
        issues: await countFor(issues, bystander.company.id),
        goals: await countFor(goals, bystander.company.id),
        projects: await countFor(projects, bystander.company.id),
        agents: await countFor(agents, bystander.company.id),
        proposals: await countFor(proposals, bystander.company.id),
        labels: await countFor(labels, bystander.company.id),
      };
      expect(after, `scope=${scope} disturbed the bystander company`).toEqual(before);

      // And the bystander's rows are the SAME rows, not a coincidental count.
      const bystanderIssue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, bystander.company.id), eq(issues.id, bystander.issueA.id)));
      expect(bystanderIssue).toHaveLength(1);

      await db.execute(
        `truncate table cost_events, finance_events, activity_log, proposals, issues, project_goals, projects, goals, agents, labels, company_memberships, companies restart identity cascade` as never,
      );
    }
  }, 120_000);

  // ─── dry run ───────────────────────────────────────────────────────────────

  it("previews by default and writes nothing", async () => {
    const seed = await seedCompany("dry");
    const report = await service.erase(seed.company.id, { scope: "company" }, ACTOR);

    expect(report.dryRun).toBe(true);
    expect(report.activityId).toBeNull();
    expect(report.totalRowsDeleted).toBeGreaterThan(0);
    expect(report.deletes.find((entry) => entry.table === "issues")?.rows).toBe(3);
    expect(report.deletes.find((entry) => entry.table === "goals")?.rows).toBe(4);
    expect(report.deletes.find((entry) => entry.table === "projects")?.rows).toBe(3);

    expect(await countFor(issues, seed.company.id)).toBe(3);
    expect(await countFor(goals, seed.company.id)).toBe(4);
    expect(await countFor(agents, seed.company.id)).toBe(1);
    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, DATA_ERASURE_ACTIVITY_ACTION));
    expect(audit).toHaveLength(0);
  }, 60_000);

  it("previews the initiative consequence BEFORE approval, not after", async () => {
    const seed = await seedCompany("preview");
    const report = await service.erase(
      seed.company.id,
      { scope: "initiatives", children: "cascade" },
      ACTOR,
    );

    expect(report.dryRun).toBe(true);
    // 2 initiatives + 1 sub-goal beneath one of them. The loose team goal is not
    // an initiative and is not underneath one, so it is not in the count.
    expect(report.deletes.find((entry) => entry.table === "goals")?.rows).toBe(3);
    // "and 2 projects" — stated in the preview, which is the whole point.
    expect(report.deletes.find((entry) => entry.table === "projects")?.rows).toBe(2);
    expect(report.deletes.find((entry) => entry.table === "issues")?.rows).toBe(3);
    expect(await countFor(goals, seed.company.id)).toBe(4);
  }, 60_000);

  // ─── confirmation ──────────────────────────────────────────────────────────

  it("refuses a confirmation that is not the company's slug", async () => {
    const seed = await seedCompany("confirm");
    await expect(
      service.erase(seed.company.id, { scope: "company", confirm: "true" }, ACTOR),
    ).rejects.toThrow(/does not match this company's slug/);
    await expect(
      service.erase(seed.company.id, { scope: "company", confirm: "company-other" }, ACTOR),
    ).rejects.toThrow(/does not match this company's slug/);
    expect(await countFor(issues, seed.company.id)).toBe(3);
  }, 60_000);

  it("404s on an unknown company rather than reporting an empty success", async () => {
    await expect(
      service.erase(randomUUID(), { scope: "company", confirm: "whatever" }, ACTOR),
    ).rejects.toThrow(/not found/i);
  }, 60_000);

  // ─── scope: company ────────────────────────────────────────────────────────

  it("empties the board but leaves the company, its members, its labels and its workforce", async () => {
    const seed = await seedCompany("wipe");
    const report = await service.erase(
      seed.company.id,
      { scope: "company", confirm: "COMPANY-WIPE" },
      ACTOR,
    );

    expect(report.blocked).toBeNull();
    expect(await countFor(issues, seed.company.id)).toBe(0);
    expect(await countFor(goals, seed.company.id)).toBe(0);
    expect(await countFor(projects, seed.company.id)).toBe(0);
    expect(await countFor(proposals, seed.company.id)).toBe(0);

    // Preserved, deliberately.
    // The AGENT is configuration — who works here, with what adapter, under
    // what permissions and prompt. A reset that took it left the company with
    // no workforce and no in-product way to recover one. Its runs, sessions
    // and cost events are gone; the record is not.
    expect(await countFor(agents, seed.company.id)).toBe(1);
    expect(await countFor(labels, seed.company.id)).toBe(1);
    expect(await countFor(companyMemberships, seed.company.id)).toBe(1);
    const company = await db.select().from(companies).where(eq(companies.id, seed.company.id));
    expect(company).toHaveLength(1);
  }, 60_000);

  it("writes exactly one audit record naming the actor, scope and counts", async () => {
    const seed = await seedCompany("audit");
    const report = await service.erase(
      seed.company.id,
      { scope: "company", confirm: seed.company.slug! },
      ACTOR,
    );

    const audit = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, seed.company.id));
    expect(audit).toHaveLength(1);
    expect(audit[0].id).toBe(report.activityId);
    expect(audit[0].action).toBe(DATA_ERASURE_ACTIVITY_ACTION);
    expect(audit[0].actorId).toBe("owner-user");
    const details = audit[0].details as Record<string, unknown>;
    expect(details.scope).toBe("company");
    expect(details.companySlug).toBe(seed.company.slug);
    expect(details.totalRowsDeleted).toBe(report.totalRowsDeleted);
    expect(Array.isArray(details.deletes)).toBe(true);
    expect(details.preserved).toContain("company_memberships");
  }, 60_000);

  // ─── scope: projects ───────────────────────────────────────────────────────

  it("cascades projects into their issues by default", async () => {
    const seed = await seedCompany("proj");
    const report = await service.erase(
      seed.company.id,
      { scope: "projects", confirm: seed.company.slug! },
      ACTOR,
    );

    expect(report.children).toBe("cascade");
    expect(await countFor(projects, seed.company.id)).toBe(0);
    // The two project-bound issues are gone; the goal-bound one survives.
    expect(await countFor(issues, seed.company.id)).toBe(1);
    // Goals are untouched — a goal is not defined by its projects.
    expect(await countFor(goals, seed.company.id)).toBe(4);
    // The cost event survived with its pointers cleared: spend that happened is
    // a fact about the company.
    const cost = await db.select().from(costEvents).where(eq(costEvents.id, seed.cost.id));
    expect(cost).toHaveLength(1);
    expect(cost[0].projectId).toBeNull();
    expect(cost[0].issueId).toBeNull();
    expect(cost[0].goalId).toBe(seed.initiativeA.id);
  }, 60_000);

  it("keeps the issues when asked to detach", async () => {
    const seed = await seedCompany("detach");
    await service.erase(
      seed.company.id,
      { scope: "projects", children: "detach", confirm: seed.company.slug! },
      ACTOR,
    );
    expect(await countFor(projects, seed.company.id)).toBe(0);
    expect(await countFor(issues, seed.company.id)).toBe(3);
    const survivor = await db.select().from(issues).where(eq(issues.id, seed.issueA.id));
    expect(survivor[0].projectId).toBeNull();
  }, 60_000);

  it("blocks when asked to block, and writes nothing", async () => {
    const seed = await seedCompany("block");
    const report = await service.erase(
      seed.company.id,
      { scope: "projects", children: "block", confirm: seed.company.slug! },
      ACTOR,
    );
    expect(report.blocked).not.toBeNull();
    expect(report.blocked!.counts).toEqual([{ table: "issues", rows: 2 }]);
    expect(report.deletes).toEqual([]);
    expect(report.activityId).toBeNull();
    expect(await countFor(projects, seed.company.id)).toBe(3);
    expect(await countFor(issues, seed.company.id)).toBe(3);
  }, 60_000);

  // ─── scope: initiatives ────────────────────────────────────────────────────

  it("blocks by default, naming the attached projects", async () => {
    const seed = await seedCompany("init");
    const report = await service.erase(
      seed.company.id,
      { scope: "initiatives", confirm: seed.company.slug! },
      ACTOR,
    );

    expect(report.children).toBe("block");
    expect(report.blocked).not.toBeNull();
    expect(report.blocked!.counts).toEqual(
      expect.arrayContaining([
        { table: "projects", rows: 2 },
        { table: "issues", rows: 1 },
      ]),
    );
    expect(report.blocked!.resolution).toContain('"children":"cascade"');
    expect(await countFor(goals, seed.company.id)).toBe(4);
    expect(await countFor(projects, seed.company.id)).toBe(3);
  }, 60_000);

  it("cascades initiatives into their projects and issues when asked", async () => {
    const seed = await seedCompany("cascade");
    const report = await service.erase(
      seed.company.id,
      { scope: "initiatives", children: "cascade", confirm: seed.company.slug! },
      ACTOR,
    );

    expect(report.blocked).toBeNull();
    // Both initiatives and the sub-goal beneath one of them are gone; the loose
    // team goal survives because it is not underneath an initiative.
    const remainingGoals = await db.select().from(goals).where(eq(goals.companyId, seed.company.id));
    expect(remainingGoals.map((row) => row.id)).toEqual([seed.looseGoal.id]);
    // Project C was attached to nothing and survives.
    const remainingProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.companyId, seed.company.id));
    expect(remainingProjects.map((row) => row.id)).toEqual([seed.projectC.id]);
    expect(await countFor(issues, seed.company.id)).toBe(0);
  }, 60_000);

  it("unlinks and keeps the projects when asked to detach", async () => {
    const seed = await seedCompany("unlink");
    const report = await service.erase(
      seed.company.id,
      { scope: "initiatives", children: "detach", confirm: seed.company.slug! },
      ACTOR,
    );

    expect(report.blocked).toBeNull();
    expect(await countFor(projects, seed.company.id)).toBe(3);
    expect(await countFor(issues, seed.company.id)).toBe(3);
    const projectA = await db.select().from(projects).where(eq(projects.id, seed.projectA.id));
    expect(projectA[0].goalId).toBeNull();
    const issueOnGoal = await db.select().from(issues).where(eq(issues.id, seed.issueOnGoal.id));
    expect(issueOnGoal[0].goalId).toBeNull();
    // The link rows went with the goals.
    const links = await db
      .select()
      .from(projectGoals)
      .where(eq(projectGoals.companyId, seed.company.id));
    expect(links).toHaveLength(0);
    // Only the loose goal is left.
    const remainingGoals = await db.select().from(goals).where(eq(goals.companyId, seed.company.id));
    expect(remainingGoals.map((row) => row.id)).toEqual([seed.looseGoal.id]);
  }, 60_000);

  // ─── atomicity ─────────────────────────────────────────────────────────────

  it("reports the same counts it then produces", async () => {
    const seed = await seedCompany("atomic");
    const preview = await service.erase(seed.company.id, { scope: "company" }, ACTOR);
    const executed = await service.erase(
      seed.company.id,
      { scope: "company", confirm: seed.company.slug! },
      ACTOR,
    );
    expect(executed.deletes).toEqual(preview.deletes);
    expect(executed.totalRowsDeleted).toBe(preview.totalRowsDeleted);
  }, 60_000);
});
