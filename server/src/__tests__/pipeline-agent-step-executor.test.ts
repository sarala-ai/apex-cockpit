/**
 * WHO EXECUTES AN AGENT STEP.
 *
 * `apex-agent-roster.test.ts` proves the seeded lifecycles NAME the right
 * agents. This proves the other half: that naming one actually resolves, and —
 * the part that matters — that failing to resolve one HOLDS the step instead of
 * quietly handing the work to whoever else is around.
 *
 * The stage here is hand-built rather than taken from a seeded lifecycle on
 * purpose: every seeded lifecycle's agent step is preceded by a `run` step that
 * shells the apex CLI on entry, and a test that needs the CLI installed to
 * check an executor lookup is a test that gets skipped on the host where it
 * mattered.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pipelineService, type PipelineActor } from "../services/pipelines.ts";
import { withBuiltInAgentMarker } from "../services/built-in-agent-metadata.ts";
import { APEX_AGENT_KEYS, apexAgentPermissionProfile } from "../services/apex-agent-roster.ts";
import { detachIssueRunReferences } from "../services/db-lock-order.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-step executor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent step executor resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pipelineService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const userActor: PipelineActor = { type: "user", userId: "board-user" };
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-step-executor-");
    db = createDb(tempDb.connectionString);
    svc = pipelineService(db, { heartbeat: noopHeartbeat });
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueComments);
    await db.delete(activityLog);
    // A successful commission really does create a heartbeat run and its
    // wakeup request, and both hard-reference the agent.
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    // `issues` <-> `heartbeat_runs` is a REFERENCE CYCLE that no delete order
    // satisfies: `heartbeat_runs.issue_id` points at `issues`, while
    // `issues.execution_run_id` / `checkout_run_id` point back at
    // `heartbeat_runs`. Deleting either table first makes the other table's FK
    // fire — and `delete from heartbeat_runs` fires `ON DELETE SET NULL` on
    // `issues`, which is the FORBIDDEN lock order (services/db-lock-order.ts)
    // and deadlocked against the still-running heartbeat dispatch this suite's
    // commissions kick off. Breaking the cycle from the issue side first is
    // both the way out of the cycle and the way to obey the order.
    await detachIssueRunReferences(db);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(approvals);
    await db.execute(sql`delete from company_skills`);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({
        name: "Roster Co",
        issuePrefix: `R${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      })
      .returning();
    return company!;
  }

  /** An ordinary agent with no built-in marker — the one the OLD resolution
   *  order would have picked as "the company's single assignable agent". */
  async function seedPlainAgent(companyId: string, name = "Some Other Agent") {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: {},
      })
      .returning();
    return agent!;
  }

  /** A company's provisioned instance of a built-in definition, identified the
   *  way the resolver identifies it: the marker in `agents.metadata`. */
  async function seedRosterAgent(companyId: string, key: string, name: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "engineering",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: { profile: apexAgentPermissionProfile(key) },
        metadata: withBuiltInAgentMarker(null, { key, featureKeys: [key] }),
      })
      .returning();
    return agent!;
  }

  /** A one-agent-step pipeline: intake -> work (agent) -> done. */
  async function seedAgentStagePipeline(companyId: string, agentKey: string) {
    return svc.createPipeline({
      companyId,
      key: `roster-${randomUUID().slice(0, 8)}`,
      name: "Roster",
      enforceTransitions: false,
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        {
          key: "work",
          name: "Work",
          kind: "working",
          config: {
            onEnter: {
              type: "agent",
              promptTemplate: "Do the thing described on {{case_key}}.",
              agentKey,
              permissions: { profile: apexAgentPermissionProfile(agentKey) },
            },
          },
        },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
  }

  /** Ingest a case and give it the conversation issue an agent step needs. */
  async function seedCaseWithConversation(companyId: string, pipelineId: string) {
    const created = await svc.ingestCase({
      companyId,
      pipelineId,
      caseKey: `case-${randomUUID().slice(0, 8)}`,
      title: "A case",
      actor: userActor,
    });
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "Conversation", status: "todo", priority: "medium" })
      .returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId,
      caseId: created.case.id,
      issueId: issue!.id,
      role: "conversation",
    });
    return { case: created.case, issue: issue! };
  }

  async function enterWorkStage(companyId: string, caseId: string, expectedVersion: number) {
    return svc.transitionCase({
      companyId,
      caseId,
      toStageKey: "work",
      expectedVersion,
      actor: userActor,
    });
  }

  async function caseEvents(caseId: string, type: string) {
    return db
      .select()
      .from(pipelineCaseEvents)
      .where(and(eq(pipelineCaseEvents.caseId, caseId), eq(pipelineCaseEvents.type, type)));
  }

  it("commissions the agent the step names, not the one the ticket happens to have", async () => {
    const company = await seedCompany();
    // Both exist. The old resolution order would have reached for neither of
    // these by key — it would have taken the issue's assignee, then the sole
    // assignable agent.
    const other = await seedPlainAgent(company.id);
    const implementer = await seedRosterAgent(company.id, APEX_AGENT_KEYS.implementer, "Implementer");
    const pipeline = await seedAgentStagePipeline(company.id, APEX_AGENT_KEYS.implementer);
    const seeded = await seedCaseWithConversation(company.id, pipeline.id);
    // Assign the ticket to the OTHER agent, so "whose ticket is this" and "who
    // may execute this step" give different answers and the tie is visible.
    await db
      .update(issues)
      .set({ assigneeAgentId: other.id })
      .where(eq(issues.id, seeded.issue.id));

    await enterWorkStage(company.id, seeded.case.id, seeded.case.version);

    const waiting = await caseEvents(seeded.case.id, "step_waiting");
    expect(waiting).toHaveLength(1);
    const payload = waiting[0]!.payload as { agentId?: string; stageKey?: string };
    expect(payload.stageKey).toBe("work");
    expect(payload.agentId).toBe(implementer.id);
    expect(payload.agentId).not.toBe(other.id);
  }, 60_000);

  /*
   * THE LOOP-BREAKING BUG, pinned.
   *
   * `claimQueuedRun` cancels a queued run whose agent differs from the issue's
   * `assigneeAgentId` (`issue_assignee_changed`) — right, because a human
   * reassigning a ticket must not leave the old owner's run to start behind
   * their back. But a STEP-declared agent has no assignment behind it, so every
   * lifecycle agent step queued a run for an agent the ticket did not belong to
   * and the heartbeat killed it seconds later. Observed live on APEX-14 at the
   * `spec` stage: the case sat at waiting_agent with no comment and no owner.
   *
   * Filling the vacuum is what makes the run survive to dispatch.
   */
  /*
   * THE SWEEP MUST ACTUALLY RUN ITS QUERY.
   *
   * `sweepWaitingAgentCases` interpolated a JS Date into a raw sql`` template,
   * which the driver cannot serialise:
   *   TypeError: The "string" argument must be of type string ... Received an
   *   instance of Date
   * It threw before reading a row, on EVERY tick, since the day it shipped —
   * so the recovery half of advancement never recovered anything. APEX-14 sat
   * stranded at `spec` for an hour while the job "ran" every five minutes.
   *
   * It shipped because `pipeline-step-sweep.test.ts` STUBS this method: it
   * proves the job is scheduled, never that the query executes. This test
   * calls the real thing against a real database, which is the only shape of
   * test that could have caught it.
   */
  it("executes the stale-case query against a real database", async () => {
    const company = await seedCompany();
    await seedRosterAgent(company.id, APEX_AGENT_KEYS.implementer, "Implementer");
    const pipeline = await seedAgentStagePipeline(company.id, APEX_AGENT_KEYS.implementer);
    const seeded = await seedCaseWithConversation(company.id, pipeline.id);

    // Parked on an agent step, but touched JUST NOW — inside the staleness
    // window, so the sweep reads it and recovers nothing. Recovery is not what
    // is under test here: the bug threw while BUILDING the query, before any
    // row was seen, so "it returned at all" is the whole assertion. Letting it
    // recover for real would commission a run and leak rows past teardown.
    await db
      .update(pipelineCases)
      .set({ stepStatus: "waiting_agent", updatedAt: new Date() })
      .where(eq(pipelineCases.id, seeded.case.id));

    const result = await svc.sweepWaitingAgentCases(5 * 60_000);

    expect(typeof result.examined).toBe("number");
    expect(result.recovered).toBe(0);
  }, 60_000);

  it("claims an unassigned ticket for the agent the step names", async () => {
    const company = await seedCompany();
    const implementer = await seedRosterAgent(company.id, APEX_AGENT_KEYS.implementer, "Implementer");
    const pipeline = await seedAgentStagePipeline(company.id, APEX_AGENT_KEYS.implementer);
    const seeded = await seedCaseWithConversation(company.id, pipeline.id);
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, seeded.issue.id));

    await enterWorkStage(company.id, seeded.case.id, seeded.case.version);

    const [after] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, seeded.issue.id));
    expect(after!.assigneeAgentId).toBe(implementer.id);
  }, 60_000);

  /*
   * The other half of the rule, and the reason this is not just "always set the
   * assignee": `assigneeAgentId` has a SECOND writer. The per-issue execution
   * policy reassigns it to the REVIEWER on a done-transition, deliberately
   * excluding the executor so review stays independent. Re-routing here would
   * silently defeat that. Fill a vacuum; never overwrite.
   */
  it("never re-routes a ticket that already has an assignee", async () => {
    const company = await seedCompany();
    const other = await seedPlainAgent(company.id, "Existing Owner");
    await seedRosterAgent(company.id, APEX_AGENT_KEYS.implementer, "Implementer");
    const pipeline = await seedAgentStagePipeline(company.id, APEX_AGENT_KEYS.implementer);
    const seeded = await seedCaseWithConversation(company.id, pipeline.id);
    await db.update(issues).set({ assigneeAgentId: other.id }).where(eq(issues.id, seeded.issue.id));

    await enterWorkStage(company.id, seeded.case.id, seeded.case.version);

    const [after] = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, seeded.issue.id));
    expect(after!.assigneeAgentId).toBe(other.id);
  }, 60_000);

  /**
   * THE SAFETY PROPERTY. A declared agent that is not provisioned must HOLD the
   * step. Falling through to the company's single assignable agent — which is
   * exactly what the resolver did before, and exactly what this company is set
   * up to allow — would mean a step declared `read-only-broad` gets executed by
   * an agent that can write the repo, silently.
   */
  it("holds the step when the named agent is not provisioned, even with one obvious candidate", async () => {
    const company = await seedCompany();
    const only = await seedPlainAgent(company.id, "The Only Agent");
    const pipeline = await seedAgentStagePipeline(company.id, APEX_AGENT_KEYS.specifier);
    const seeded = await seedCaseWithConversation(company.id, pipeline.id);

    await enterWorkStage(company.id, seeded.case.id, seeded.case.version);

    expect(await caseEvents(seeded.case.id, "step_waiting")).toHaveLength(0);
    const failures = await caseEvents(seeded.case.id, "automation_failed");
    expect(failures).toHaveLength(1);
    const error = String((failures[0]!.payload as { error?: string }).error ?? "");
    expect(error).toContain("agent_step_executor_unresolved");
    // The message names the agent, so the fix ("provision it") is legible from
    // the event alone rather than requiring someone to read this resolver.
    expect(error).toContain(APEX_AGENT_KEYS.specifier);

    const [row] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, seeded.case.id));
    expect(row!.stepExecutorAgentId).toBeNull();
    expect(row!.stepStatus).toBeNull();
    expect(only.id).toBeTruthy();
  }, 60_000);

  /**
   * A stage an operator authored on the board declares no agent, and must keep
   * behaving exactly as it did — the `agentKey` branch is additive, not a
   * replacement for the case/ticket resolution beneath it.
   */
  it("still resolves by the ticket when the step names no agent", async () => {
    const company = await seedCompany();
    const only = await seedPlainAgent(company.id, "The Only Agent");
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: `unnamed-${randomUUID().slice(0, 8)}`,
      name: "Unnamed",
      enforceTransitions: false,
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        {
          key: "work",
          name: "Work",
          kind: "working",
          config: { onEnter: { type: "agent", promptTemplate: "Do the thing." } },
        },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const seeded = await seedCaseWithConversation(company.id, pipeline.id);

    await enterWorkStage(company.id, seeded.case.id, seeded.case.version);

    const waiting = await caseEvents(seeded.case.id, "step_waiting");
    expect(waiting).toHaveLength(1);
    expect((waiting[0]!.payload as { agentId?: string }).agentId).toBe(only.id);
  }, 60_000);
});
