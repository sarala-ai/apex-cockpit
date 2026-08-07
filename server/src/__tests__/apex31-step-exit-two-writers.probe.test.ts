/**
 * APEX-31 FAILING PROBE — an agent step's successful exit, and the two writers
 * that disagree about what it meant.
 *
 * This suite is COMMISSIONED RED. It asserts the contract the coordinator is
 * supposed to honour; today's code fails both tests, reproducing what was
 * observed live on APEX-14 (runs f0c78e92 / 90f1b0ed / 1471b4a5, Aug 7) and
 * APEX-27 (run c433deb4). Do not "fix" the assertions — fix the coordinator.
 *
 * Defect (a) — the success path never clears the step's active hold.
 *
 *   `executeRunEntryLedger` (the `run` kind) clears the stage's hold on a
 *   successful exit (`clearStepHold(run_exit_success)`, pipelines.ts ~4005)
 *   before re-evaluating acceptance and moving the case. The AGENT kind's
 *   completion — `processAgentStepCompletion` — does not. When the stage's
 *   declared acceptance is `disabled` (as every seeded lifecycle's uncheckable
 *   criteria are), `evaluateStageAcceptance` returns `none` without writing an
 *   event or clearing anything, and the exit transition then runs straight
 *   into the STALE hold from the previous failed attempt:
 *   `assertStageTransitionGates` throws `stage_held`, the coordinator records
 *   a NEW hold (`step_exit_transition_blocked`) wrapping the old message —
 *   observed live as "Pipeline stage is held: Pipeline stage is held: ..." —
 *   and the hold is immortal: every successful rerun re-wraps it and the case
 *   never advances.
 *
 * Defect (b) — the ticket has a second writer that ignores the case.
 *
 *   While the case sits mid-pipeline, the issue-side machinery (liveness
 *   continuations and disposition-handoff wakes, which carry none of the
 *   step's context markers) tells the assignee to give the ISSUE a final
 *   disposition, and the agent marks it `done` through the ordinary issue
 *   update path. The server accepts it. Result observed three times: ticket
 *   `done`, case non-terminal on the same screen. The case is the single
 *   writer for "this work is finished"; an agent-driven `done` on an issue
 *   that is the conversation of a live pipeline case must be refused.
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
import { issueService } from "../services/issues.ts";
import { withBuiltInAgentMarker } from "../services/built-in-agent-metadata.ts";
import { APEX_AGENT_KEYS, apexAgentPermissionProfile } from "../services/apex-agent-roster.ts";
import { detachIssueRunReferences } from "../services/db-lock-order.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping APEX-31 probe on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("APEX-31 probe: agent step exit vs the ticket", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pipelineService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const userActor: PipelineActor = { type: "user", userId: "board-user" };
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex31-probe-");
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
    await db.delete(heartbeatRunEvents);
    await db.delete(agentTaskSessions);
    // `issues` <-> `heartbeat_runs` is a reference cycle; break it from the
    // issue side first (see db-lock-order.ts and the executor suite).
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
        name: "Probe Co",
        issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "board-user",
      })
      .returning();
    return company!;
  }

  async function seedSpecifier(companyId: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "Specifier",
        role: "engineering",
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
        runtimeConfig: {},
        permissions: { profile: apexAgentPermissionProfile(APEX_AGENT_KEYS.specifier) },
        metadata: withBuiltInAgentMarker(null, {
          key: APEX_AGENT_KEYS.specifier,
          featureKeys: [APEX_AGENT_KEYS.specifier],
        }),
      })
      .returning();
    return agent!;
  }

  /**
   * The APEX-14 shape, minimally: an agent stage whose declared acceptance is
   * DISABLED (the criteria are prose the v1 grammar cannot check, which is
   * exactly what every seeded lifecycle stage carries), routing to `done` on
   * success.
   */
  async function seedSpecPipeline(companyId: string) {
    return svc.createPipeline({
      companyId,
      key: `probe-${randomUUID().slice(0, 8)}`,
      name: "Probe",
      enforceTransitions: false,
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        {
          key: "spec",
          name: "Spec",
          kind: "working",
          config: {
            onEnter: {
              type: "agent",
              promptTemplate: "Draft the spec for {{case_key}}.",
              agentKey: APEX_AGENT_KEYS.specifier,
              permissions: { profile: apexAgentPermissionProfile(APEX_AGENT_KEYS.specifier) },
              onSuccessToStageKey: "done",
            },
            acceptance: {
              criteria: "spec document exists with a task list and acceptance criteria per task",
              disabled: true,
            },
          },
        },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
  }

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

  async function caseEvents(caseId: string, type: string) {
    return db
      .select()
      .from(pipelineCaseEvents)
      .where(and(eq(pipelineCaseEvents.caseId, caseId), eq(pipelineCaseEvents.type, type)))
      .orderBy(pipelineCaseEvents.createdAt, pipelineCaseEvents.id);
  }

  async function caseDetail(companyId: string, caseId: string) {
    const [row] = await db
      .select({ case: pipelineCases, stage: pipelineStages })
      .from(pipelineCases)
      .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
      .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId)));
    return row!;
  }

  /**
   * Drive the case into the spec stage (which parks it `waiting_agent` and
   * commissions for real), then record the first attempt's run terminating the
   * way APEX-14's did on Aug 4 — cancelled under the queued-run assignee
   * guard — which writes the `agent_run_cancelled` hold.
   */
  async function seedHeldSpecCase(companyId: string, pipelineId: string) {
    const seeded = await seedCaseWithConversation(companyId, pipelineId);
    await svc.transitionCase({
      companyId,
      caseId: seeded.case.id,
      toStageKey: "spec",
      expectedVersion: seeded.case.version,
      actor: userActor,
    });
    const completed = await svc.processAgentStepCompletion(companyId, seeded.case.id, {
      runId: randomUUID(),
      runStatus: "cancelled",
      error:
        "Cancelled because issue assignee changed before the queued run could start; the new owner will be woken instead",
    });
    expect(completed).toBe(true);
    const holds = await caseEvents(seeded.case.id, "step_held");
    expect(holds.length).toBeGreaterThan(0);
    return seeded;
  }

  it(
    "a successful rerun of a held agent step clears the hold and advances the case " +
      "(observed live: the hold is immortal and the exit is re-blocked forever)",
    async () => {
      const company = await seedCompany();
      await seedSpecifier(company.id);
      const pipeline = await seedSpecPipeline(company.id);
      const seeded = await seedHeldSpecCase(company.id, pipeline.id);

      // The operator's recovery affordance: re-run the stage's entry step.
      // This re-parks the case and commissions a fresh bounded run.
      await svc.rerunCurrentStageAutomation({
        companyId: company.id,
        caseId: seeded.case.id,
        actor: userActor,
      });
      const reparked = await caseDetail(company.id, seeded.case.id);
      expect(reparked.case.stepStatus).toBe("waiting_agent");

      // The rerun's bounded run reaches `succeeded` — the agent-step
      // completion hook hands it to the coordinator, exactly as
      // notifyStepHostOfTerminalRun does.
      const completed = await svc.processAgentStepCompletion(company.id, seeded.case.id, {
        runId: reparked.case.stepRunId ?? randomUUID(),
        runStatus: "succeeded",
        error: null,
      });
      expect(completed).toBe(true);

      // THE CONTRACT — soft assertions so one probe run reports every
      // divergence. A successful exit supersedes the previous attempt's
      // failure hold — the same rule the `run` kind already honours
      // (`clearStepHold(run_exit_success)`). The stale hold must be cleared...
      const clears = await caseEvents(seeded.case.id, "step_hold_cleared");
      expect.soft(clears.length, "step_hold_cleared events after successful exit").toBeGreaterThan(0);

      // ...the exit must not be re-blocked by the hold the success just
      // superseded (observed live: `step_exit_transition_blocked` wrapping
      // "Pipeline stage is held: Pipeline stage is held: ...")...
      const holds = await caseEvents(seeded.case.id, "step_held");
      const exitBlocked = holds.filter(
        (event) =>
          (event.payload as { reason?: string }).reason === "step_exit_transition_blocked",
      );
      expect.soft(exitBlocked, "step_exit_transition_blocked holds").toHaveLength(0);

      // ...and the case must actually move where the step routes on success.
      const after = await caseDetail(company.id, seeded.case.id);
      expect.soft(after.stage.key, "stage after successful exit").toBe("done");
    },
    60_000,
  );

  it(
    "an agent cannot mark the ticket done while its pipeline case is non-terminal " +
      "(observed live: liveness/handoff runs flip the ticket while the case is held)",
    async () => {
      const company = await seedCompany();
      const specifier = await seedSpecifier(company.id);
      const pipeline = await seedSpecPipeline(company.id);
      const seeded = await seedHeldSpecCase(company.id, pipeline.id);

      // The ticket is the case's conversation, mid-flight, owned by the agent.
      await db
        .update(issues)
        .set({ assigneeAgentId: specifier.id, status: "in_progress" })
        .where(eq(issues.id, seeded.issue.id));

      // The second writer: a continuation/handoff run's disposition write —
      // the ordinary agent-actor issue update the routes call. The case is
      // still at `spec` and held; the pipeline owns ticket completion, so this
      // write must be refused (or left un-applied), never accepted.
      await issueService(db)
        .update(seeded.issue.id, { status: "done", actorAgentId: specifier.id })
        .catch(() => null);

      const [ticket] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, seeded.issue.id));
      const after = await caseDetail(company.id, seeded.case.id);

      expect(after.case.terminalKind).toBeNull();
      expect(ticket!.status).not.toBe("done");
    },
    60_000,
  );
});
