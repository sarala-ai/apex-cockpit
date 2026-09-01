import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  projects,
  routineDocuments,
  routineRevisions,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { routineRoutes } from "../routes/routines.js";
import { accessService } from "../services/access.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres delete route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue and routine delete routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delete-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(issueThreadInteractions);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routineDocuments);
    await db.delete(routineRevisions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(routines);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(projects);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", issueRoutes(db, {} as never));
    instance.use("/api", routineRoutes(db));
    instance.use(errorHandler);
    return instance;
  }

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  async function seedCompany(name = "Delete Co") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `D${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function seedAgent(companyId: string, name = "Deleter") {
    const [agent] = await db.insert(agents).values({
      companyId,
      name,
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    return agent!;
  }

  /**
   * The regression fixture: an issue carrying all four children that used to
   * reference `issues` without ON DELETE CASCADE.
   */
  async function seedIssueWithAllChildren(companyId: string, agentId: string) {
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Issue with every child row",
      status: "todo",
      priority: "medium",
    }).returning();

    await db.insert(issueComments).values({
      companyId,
      issueId: issue!.id,
      authorType: "system",
      authorUserId: "local-board",
      body: "System comment — the row that made this issue undeletable.",
    });
    await db.insert(issueReadStates).values({
      companyId,
      issueId: issue!.id,
      userId: "board-user",
    });
    await db.insert(issueInboxArchives).values({
      companyId,
      issueId: issue!.id,
      userId: "board-user",
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: issue!.id,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      title: "Confirm something",
      createdByAgentId: agentId,
      payload: {
        version: 1,
        prompt: "Confirm?",
        acceptLabel: "Yes",
        rejectLabel: "No",
      },
    });

    return issue!;
  }

  it("deletes an issue that has comments, read states, inbox archives and thread interactions", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const issue = await seedIssueWithAllChildren(company.id, agent.id);

    await request(app(boardActor)).delete(`/api/issues/${issue.id}`).expect(200);

    expect(await db.select().from(issues).where(eq(issues.id, issue.id))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(issueReadStates).where(eq(issueReadStates.issueId, issue.id))).toHaveLength(0);
    expect(await db.select().from(issueInboxArchives).where(eq(issueInboxArchives.issueId, issue.id))).toHaveLength(0);
    expect(
      await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issue.id)),
    ).toHaveLength(0);
  });

  it("classifies a genuinely blocked issue delete instead of returning a 500", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const issue = await seedIssueWithAllChildren(company.id, agent.id);

    // cost_events intentionally references issues without a cascade — ledger
    // rows outlive the issue, so this delete must stay blocked.
    await db.insert(costEvents).values({
      companyId: company.id,
      agentId: agent.id,
      issueId: issue.id,
      provider: "anthropic",
      model: "claude",
      costCents: 12,
      occurredAt: new Date(),
    });

    const res = await request(app(boardActor)).delete(`/api/issues/${issue.id}`).expect(409);
    expect(res.body.code).toBe("issue_delete_blocked");
    expect(res.body.error).toContain("cost events");
    expect(res.body.details.blockedBy).toBe("cost_events");
    expect(res.body.remediation).toContain("cost events");
    expect(await db.select().from(issues).where(eq(issues.id, issue.id))).toHaveLength(1);
  });

  it("refuses an issue delete from another company", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const issue = await seedIssueWithAllChildren(company.id, agent.id);

    const otherCompany = await seedCompany("Other Co");
    const otherAgent = await seedAgent(otherCompany.id, "Outsider");
    const foreignActor: Express.Request["actor"] = {
      type: "agent",
      agentId: otherAgent.id,
      companyId: otherCompany.id,
      runId: randomUUID(),
      source: "agent_key",
    };

    await request(app(foreignActor)).delete(`/api/issues/${issue.id}`).expect(403);
    expect(await db.select().from(issues).where(eq(issues.id, issue.id))).toHaveLength(1);
  });

  async function seedRoutineFixture(company: { id: string }, agentId: string) {
    const access = accessService(db);
    const membership = await access.ensureMembership(company.id, "user", "board-user", "owner", "active");
    await access.setMemberPermissions(
      company.id,
      membership.id,
      [{ permissionKey: "tasks:assign" }],
      "board-user",
    );

    const http = request(app(boardActor));
    const created = await http
      .post(`/api/companies/${company.id}/routines`)
      .send({
        title: "Nightly sweep",
        description: "Sweep the board every night.",
        assigneeAgentId: agentId,
        status: "active",
      })
      .expect(201);
    const routineId = created.body.id as string;

    await http
      .post(`/api/routines/${routineId}/triggers`)
      .send({ kind: "schedule", cronExpression: "0 2 * * *", timezone: "UTC", enabled: true })
      .expect(201);

    await db.insert(routineRuns).values({
      companyId: company.id,
      routineId,
      source: "manual",
      status: "completed",
      triggeredAt: new Date(),
    });

    return routineId;
  }

  it("deletes a routine and cascades to revisions, triggers, runs and its description document", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const routineId = await seedRoutineFixture(company, agent.id);

    const documentIds = (
      await db.select().from(routineDocuments).where(eq(routineDocuments.routineId, routineId))
    ).map((row) => row.documentId);

    const res = await request(app(boardActor)).delete(`/api/routines/${routineId}`).expect(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.deletedTriggerCount).toBe(1);
    expect(res.body.deletedRunCount).toBe(1);
    expect(res.body.deletedRevisionCount).toBeGreaterThan(0);

    expect(await db.select().from(routines).where(eq(routines.id, routineId))).toHaveLength(0);
    expect(await db.select().from(routineRevisions).where(eq(routineRevisions.routineId, routineId))).toHaveLength(0);
    expect(await db.select().from(routineTriggers).where(eq(routineTriggers.routineId, routineId))).toHaveLength(0);
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId))).toHaveLength(0);
    expect(await db.select().from(routineDocuments).where(eq(routineDocuments.routineId, routineId))).toHaveLength(0);
    for (const documentId of documentIds) {
      expect(await db.select().from(documents).where(eq(documents.id, documentId))).toHaveLength(0);
    }

    await request(app(boardActor)).get(`/api/routines/${routineId}`).expect(404);
  });

  it("returns 404 deleting an unknown routine", async () => {
    await request(app(boardActor)).delete(`/api/routines/${randomUUID()}`).expect(404);
  });

  it("refuses a routine delete from another company", async () => {
    const company = await seedCompany();
    const agent = await seedAgent(company.id);
    const routineId = await seedRoutineFixture(company, agent.id);

    const otherCompany = await seedCompany("Other Routine Co");
    const otherAgent = await seedAgent(otherCompany.id, "Outsider");
    const foreignActor: Express.Request["actor"] = {
      type: "agent",
      agentId: otherAgent.id,
      companyId: otherCompany.id,
      runId: randomUUID(),
      source: "agent_key",
    };

    await request(app(foreignActor)).delete(`/api/routines/${routineId}`).expect(403);
    expect(await db.select().from(routines).where(eq(routines.id, routineId))).toHaveLength(1);
  });
});
