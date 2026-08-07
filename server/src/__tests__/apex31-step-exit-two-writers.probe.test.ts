/**
 * APEX-31 FAILING PROBE, take two — the wiring seam and the real second writer.
 *
 * The first take (7ce94e3b0) was rejected: it entered one seam too low and was
 * GREEN on unfixed code. Both tests here enter where the live failures enter,
 * verified against the live instance database (Aug 7):
 *
 * Defect (a) — the terminal notification outruns the linkage, every time.
 *
 *   When the stage's declared executor is not the ticket's assignee (the
 *   ticket is non-null — carried over from a previous stage — so the
 *   fill-a-vacuum rule correctly refuses to re-route), the commission's
 *   `enqueueWakeup` creates the queued step run and the claim gate cancels it
 *   INSIDE the same call chain: `issue_assignee_changed`, "the new owner will
 *   be woken instead". The cancel goes through `setRunStatus` →
 *   `notifyStepHostOfTerminalRun`, which looks the case up by
 *   `pipelineCases.stepRunId = run.id` — but `recordCommissioned` has not run
 *   yet, so nothing maps run→case-step and the hook returns without firing.
 *   Only afterwards does the coordinator write `stepRunId`, now pointing at a
 *   run that is already terminal and will never be notified again. The
 *   substitute wake for the assignee carries none of the step's context
 *   markers, so its terminal status is invisible to the coordinator too.
 *
 *   Live forensics (APEX-27, case d9a968fa, Aug 7 06:41:00): queued step run
 *   f48378dd created .148, cancelled .163 (`issue_assignee_changed`), the
 *   ledger's `automation_executed` written .167 — strictly after the terminal
 *   notification. The case got its `agent_run_cancelled` hold only from the
 *   staleness SWEEP nine minutes later, the ledger says `succeeded`,
 *   `step_run_id` is null, the case is non-terminal at `tasks` — and the
 *   ISSUE is `done`.
 *
 *   The probe drives `rerunCurrentStageAutomation` through the REAL
 *   dispatch/commission/claim path to the real terminal notification. No
 *   caseId/runId is hand-delivered to the coordinator. The contract asserted:
 *   the coordinator observes the commissioned run's terminal status without
 *   waiting for the sweep. Today it never does.
 *
 * Defect (b) — the ticket's second writer, in its real shape.
 *
 *   Live forensics for the APEX-14 done-flip (issue 732422af, Aug 7): the
 *   `finish_successful_run_handoff` run c13a76bd wrote `issue.updated` +
 *   `issue.successful_run_handoff_resolved` at 05:55:23 with an AGENT actor —
 *   the ordinary issueService.update path the routes call. The case link for
 *   that issue has role `work`, NOT `conversation` (the live lifecycles link
 *   the ticket as the case's work item). Any guard that only inspects
 *   `role = 'conversation'` links never fires on the live topology, and the
 *   ticket flips `done` while the case is held mid-pipeline. The probe writes
 *   through the same seam with the same link role and asserts the pipeline
 *   stays the single writer for terminal ticket status.
 *
 * This suite is COMMISSIONED RED. Do not "fix" the assertions — fix the
 * wiring.
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

async function poll<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 30_000, intervalMs = 250 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describeEmbeddedPostgres("APEX-31 probe: agent step exit vs the ticket", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pipelineService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const userActor: PipelineActor = { type: "user", userId: "board-user" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-apex31-probe-");
    db = createDb(tempDb.connectionString);
    // No stubbed heartbeat anywhere: the commission path lazy-imports the real
    // heartbeatService, and this suite is ABOUT that wiring.
    svc = pipelineService(db);
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

  /** The APEX-14 shape: an agent stage whose declared acceptance is prose the
   *  v1 grammar cannot check, routing to `done` on success. */
  async function seedSpecPipeline(companyId: string, agentKey: string = APEX_AGENT_KEYS.specifier) {
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
              agentKey,
              permissions: { profile: apexAgentPermissionProfile(agentKey) },
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

  /** The LIVE link topology, verified in the instance database: the ticket is
   *  linked to the case with role `work` (APEX-14 case 45ff15d4, APEX-27 case
   *  d9a968fa both carry role `work`, and NO `conversation` link exists). A
   *  probe that seeds `conversation` instead exercises a topology the live
   *  system does not have. */
  async function seedCaseWithWorkTicket(companyId: string, pipelineId: string) {
    const created = await svc.ingestCase({
      companyId,
      pipelineId,
      caseKey: `case-${randomUUID().slice(0, 8)}`,
      title: "A case",
      actor: userActor,
    });
    const [issue] = await db
      .insert(issues)
      .values({ companyId, title: "Ticket", status: "todo", priority: "medium" })
      .returning();
    await db.insert(pipelineCaseIssueLinks).values({
      companyId,
      caseId: created.case.id,
      issueId: issue!.id,
      role: "work",
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

  it(
    "a commissioned step run cancelled at the claim gate is still observed by the coordinator " +
      "(observed live: the terminal notification outruns recordCommissioned, the hook never fires, " +
      "and only the sweep — minutes later — notices)",
    async () => {
      const company = await seedCompany();
      const specifier = await seedSpecifier(company.id);
      await seedRosterAgent(company.id, APEX_AGENT_KEYS.implementer, "Implementer");
      // The stage names the IMPLEMENTER as executor while the ticket belongs
      // to the SPECIFIER — the live APEX-27 shape at the `tasks` stage: the
      // assignee carried over from the previous stage, the fill-a-vacuum rule
      // correctly refuses to re-route a non-null assignee, and the claim gate
      // then cancels every run commissioned for the executor.
      const pipeline = await seedSpecPipeline(company.id, APEX_AGENT_KEYS.implementer);
      const seeded = await seedCaseWithWorkTicket(company.id, pipeline.id);
      await db
        .update(issues)
        .set({ assigneeAgentId: specifier.id, status: "in_progress" })
        .where(eq(issues.id, seeded.issue.id));

      // Enter the stage through the pipeline's own transition — the entry
      // step enqueues its ledger and commissions for real.
      await svc.transitionCase({
        companyId: company.id,
        caseId: seeded.case.id,
        toStageKey: "spec",
        expectedVersion: seeded.case.version,
        actor: userActor,
      });

      // The operator's recovery affordance, the seam under test: re-run the
      // stage's entry automation. Everything downstream is the REAL wiring —
      // `enqueueWakeup` creates the queued run, the claim gate cancels it
      // (`issue_assignee_changed`) through `setRunStatus`, which calls
      // `notifyStepHostOfTerminalRun`. Nothing here hands the coordinator a
      // caseId or runId.
      await svc.rerunCurrentStageAutomation({
        companyId: company.id,
        caseId: seeded.case.id,
        actor: userActor,
      });

      // Ground truth of the defect, not the contract: the commissioned step
      // runs exist, carry the step's context markers, and are ALREADY
      // terminal — cancelled by the claim gate before they could start.
      const stepRuns = await poll(async () => {
        const rows = await db
          .select()
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, company.id),
              sql`${heartbeatRuns.contextSnapshot} ->> 'flowAgentStep' = 'true'`,
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${seeded.issue.id}`,
            ),
          );
        return rows.length > 0 && rows.every((row) => row.status === "cancelled") ? rows : null;
      }, { timeoutMs: 30_000 });
      expect(
        stepRuns,
        "the commissioned step runs were cancelled at the claim gate (issue_assignee_changed)",
      ).not.toBeNull();
      expect(stepRuns!.every((row) => row.errorCode === "issue_assignee_changed")).toBe(true);

      // The ledger recorded the commission as a clean success, and the case is
      // parked waiting for an agent that can never arrive.
      const ledgers = await db
        .select()
        .from(pipelineAutomationExecutions)
        .where(eq(pipelineAutomationExecutions.caseId, seeded.case.id));
      expect(ledgers.some((row) => row.kind === "agent" && row.status === "succeeded")).toBe(true);
      const parked = await caseDetail(company.id, seeded.case.id);
      expect(parked.case.stepStatus).toBe("waiting_agent");

      // THE CONTRACT: the coordinator observes the commissioned run's terminal
      // status — it records the exit on the case (the `agent_run_cancelled`
      // hold, a re-commission, anything) without waiting for the staleness
      // sweep. Live: the terminal notification fired before `stepRunId` was
      // written, found no case, and the case sat invisible for nine minutes
      // until the sweep; in this probe no sweep runs, so nothing ever comes.
      const observed = await poll(async () => {
        const holds = await caseEvents(seeded.case.id, "step_held");
        const detail = await caseDetail(company.id, seeded.case.id);
        const settled = detail.case.stepStatus !== "waiting_agent";
        return holds.length > 0 || settled ? true : null;
      }, { timeoutMs: 15_000 });
      expect(
        observed,
        "the coordinator recorded the cancelled step run's terminal outcome on the case",
      ).toBe(true);
    },
    120_000,
  );

  it(
    "an agent-actor disposition write cannot mark the ticket done while its pipeline case is live " +
      "(observed live: the finish_successful_run_handoff run flips a work-linked ticket while the case is held)",
    async () => {
      const company = await seedCompany();
      const specifier = await seedSpecifier(company.id);
      const pipeline = await seedSpecPipeline(company.id);
      const seeded = await seedCaseWithWorkTicket(company.id, pipeline.id);

      // Mid-flight, owned by the agent — the exact state APEX-14's ticket was
      // in when handoff run c13a76bd wrote `done` at 05:55:23 (agent actor,
      // `issue.successful_run_handoff_resolved` in the activity log) while
      // the case sat held at `spec`.
      await svc.transitionCase({
        companyId: company.id,
        caseId: seeded.case.id,
        toStageKey: "spec",
        expectedVersion: seeded.case.version,
        actor: userActor,
      });
      await db
        .update(issues)
        .set({ assigneeAgentId: specifier.id, status: "in_progress" })
        .where(eq(issues.id, seeded.issue.id));

      // The second writer, in its real shape: the disposition write the
      // handoff/liveness run performs through the ordinary agent-actor issue
      // update the routes call. The live link topology is role `work` — a
      // guard that only looks for `conversation` links never sees this issue.
      await issueService(db)
        .update(seeded.issue.id, { status: "done", actorAgentId: specifier.id })
        .catch(() => null);

      const [ticket] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, seeded.issue.id));
      const after = await caseDetail(company.id, seeded.case.id);

      // THE CONTRACT: the pipeline case is the single writer for "this work
      // is finished". While the case is non-terminal, an agent-driven `done`
      // on its ticket must be refused or left un-applied — whatever link role
      // carries the relationship.
      expect(after.case.terminalKind).toBeNull();
      expect(ticket!.status, "ticket status after agent disposition write on a live case").not.toBe(
        "done",
      );
    },
    120_000,
  );
});
