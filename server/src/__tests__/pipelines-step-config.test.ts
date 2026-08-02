/**
 * The two missing members of a stage's step config — step 3 of the
 * execution-substrate merge (docs/architecture/execution-substrate.md §6).
 *
 * What these tests are actually for:
 *  - a `run` entry step WRITES ITS EXIT STATUS BACK (the old
 *    zero-token escape hatch ran and then nothing read the result);
 *  - a stage `acceptance` block is evaluated by the SERVER and HOLDS the
 *    stage when it fails;
 *  - neither path touches an agent, a routine or a heartbeat run.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseIssueLinks,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pipelineService, type PipelineActor } from "../services/pipelines.ts";
import type { StepTargetRunner, NodeExecutionResult } from "../apex/steps/runner.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stage step-config tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipeline stage step config — the run step and its acceptance contract", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const userActor: PipelineActor = { type: "user", userId: "board-user" };
  const noopHeartbeat = { wakeup: async () => null };

  /** The deterministic runner, stubbed. Every call it receives is recorded, so
   *  a test can assert exactly what the platform shelled — and, just as
   *  importantly, that nothing else ran. */
  function stubRunner(result: NodeExecutionResult) {
    const workflowCalls: Array<{ workflow: string; params: Record<string, unknown> }> = [];
    const commandCalls: string[] = [];
    const runner: StepTargetRunner = {
      runWorkflow: async (config) => {
        workflowCalls.push({ workflow: config.workflow, params: config.params });
        return result;
      },
      runCommand: async (config) => {
        commandCalls.push(config.tool);
        return result;
      },
    };
    return { runner, workflowCalls, commandCalls };
  }

  function serviceWith(runner: StepTargetRunner) {
    return pipelineService(db, { heartbeat: noopHeartbeat, stepRunner: runner });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipelines-step-config-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelineCaseBlockers);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(routineRuns);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(routines);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPipeline(svc: ReturnType<typeof pipelineService>) {
    const [company] = await db.insert(companies).values({
      name: "Pipeline Co",
      issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const pipeline = await svc.createPipeline({
      companyId: company!.id,
      key: `substrate-${randomUUID().slice(0, 8)}`,
      name: "Substrate",
      actor: userActor,
    });
    const stages = await svc.listStages(company!.id, pipeline.id);
    return {
      company: company!,
      pipeline,
      byKey: new Map(stages.map((stage) => [stage.key, stage])),
    };
  }

  async function eventsOfType(caseId: string, type: string) {
    return db
      .select()
      .from(pipelineCaseEvents)
      .where(sql`${pipelineCaseEvents.caseId} = ${caseId} and ${pipelineCaseEvents.type} = ${type}`);
  }

  async function currentStageKey(caseId: string) {
    const [row] = await db
      .select({ stepKey: pipelineCases.stepKey, version: pipelineCases.version })
      .from(pipelineCases)
      .where(eq(pipelineCases.id, caseId));
    return row!;
  }

  /*
   * The v1 grammar answers anything it does not recognise with a PASS marked
   * "unverified". Harmless as a note beside a flow agent run; not harmless as a
   * stage contract, where it would let work out while reporting green. These
   * pin the refusal at authoring time, which is the only moment a person is
   * looking at the config.
   */
  it("refuses stage acceptance criteria the server cannot actually check", async () => {
    const { runner } = stubRunner({ ok: true, detail: { status: "success" } });
    const svc = serviceWith(runner);
    const { company, pipeline, byKey } = await seedPipeline(svc);

    await expect(
      svc.updateStage({
        companyId: company.id,
        pipelineId: pipeline.id,
        stageId: byKey.get("in_progress")!.id,
        patch: { config: { acceptance: { criteria: "the deployment looks healthy" } } },
        actor: userActor,
      }),
    ).rejects.toThrow(/server-checkable/);
  });

  it("accepts both grammar forms, and an explicitly disabled contract", async () => {
    const { runner } = stubRunner({ ok: true, detail: { status: "success" } });
    const svc = serviceWith(runner);
    const { company, pipeline, byKey } = await seedPipeline(svc);
    const stageId = byKey.get("in_progress")!.id;

    for (const acceptance of [
      { criteria: "file_exists: build/report.json" },
      { criteria: "pr_exists: sarala-ai/apex-cockpit#feature-branch" },
      // An explicit waiver stays available — saying "no contract here" out loud
      // is the honest alternative to prose that pretends to be one.
      { criteria: "reviewed by a person", disabled: true },
    ]) {
      const updated = await svc.updateStage({
        companyId: company.id,
        pipelineId: pipeline.id,
        stageId,
        patch: { config: { acceptance } },
        actor: userActor,
      });
      expect(updated).toBeTruthy();
    }
  });

  it("runs a workflow entry step and moves the case on a zero exit", async () => {
    const { runner, workflowCalls } = stubRunner({ ok: true, detail: { status: "success" } });
    const svc = serviceWith(runner);
    const { company, pipeline, byKey } = await seedPipeline(svc);

    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          onEnter: {
            type: "run",
            target: { type: "workflow", workflow: "open-pr", params: { head: "design/{{case_key}}" } },
            onSuccessToStageKey: "review",
          },
        },
      },
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "APE-7",
      title: "Workflow entry",
      actor: userActor,
    });
    const result = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: created.case.version,
      actor: userActor,
    });

    // The exit status moved the case: entering in_progress ran the workflow,
    // which succeeded, which transitioned it on to review.
    expect(result.automationExecution.status).toBe("succeeded");
    expect((await currentStageKey(created.case.id)).stepKey).toBe("review");
    // Params interpolated against the case before the workflow ran.
    expect(workflowCalls).toEqual([{ workflow: "open-pr", params: { head: "design/APE-7" } }]);

    const [ledger] = await db.select().from(pipelineAutomationExecutions);
    expect(ledger).toMatchObject({ kind: "run", routineId: null, status: "succeeded" });
    const executed = await eventsOfType(created.case.id, "automation_executed");
    expect(executed).toHaveLength(1);
    expect(executed[0]!.payload).toMatchObject({
      kind: "run",
      result: { target: "workflow", workflow: "open-pr" },
    });
  });

  it("HOLDS the stage when a workflow entry step exits non-zero with no failure route", async () => {
    const { runner } = stubRunner({ ok: false, errorType: "workflow_failed", message: "step 2 failed" });
    const svc = serviceWith(runner);
    const { company, pipeline, byKey } = await seedPipeline(svc);

    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: { config: { onEnter: { type: "run", target: { type: "workflow", workflow: "open-pr" } } } },
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "APE-8",
      title: "Workflow entry failure",
      actor: userActor,
    });
    const result = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: created.case.version,
      actor: userActor,
    });
    expect(result.automationExecution.status).toBe("failed");

    const held = await eventsOfType(created.case.id, "step_held");
    expect(held).toHaveLength(1);
    expect(held[0]!.payload).toMatchObject({ reason: "run_exit_failure", errorType: "workflow_failed" });

    // The hold is not decoration: the case cannot leave the stage.
    const current = await currentStageKey(created.case.id);
    expect(current.stepKey).toBe("in_progress");
    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "review",
        expectedVersion: current.version,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "stage_held" } });
  });

  it("routes a non-zero exit to onFailureToStageKey when the stage declares one", async () => {
    const { runner } = stubRunner({ ok: false, errorType: "workflow_failed", message: "boom" });
    const svc = serviceWith(runner);
    const { company, pipeline, byKey } = await seedPipeline(svc);

    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          onEnter: {
            type: "run",
            target: { type: "workflow", workflow: "open-pr" },
            onFailureToStageKey: "cancelled",
          },
        },
      },
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "APE-9",
      title: "Workflow entry failure route",
      actor: userActor,
    });
    await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: created.case.version,
      actor: userActor,
    });

    expect((await currentStageKey(created.case.id)).stepKey).toBe("cancelled");
    expect(await eventsOfType(created.case.id, "step_held")).toHaveLength(0);
  });

  it("rejects an entry step whose declared stage keys do not exist", async () => {
    const svc = serviceWith(stubRunner({ ok: true, detail: {} }).runner);
    const { company, pipeline, byKey } = await seedPipeline(svc);

    await expect(
      svc.updateStage({
        companyId: company.id,
        pipelineId: pipeline.id,
        stageId: byKey.get("in_progress")!.id,
        patch: {
        config: {
          onEnter: {
            type: "run",
            target: { type: "workflow", workflow: "open-pr" },
            onSuccessToStageKey: "nope",
          },
        },
      },
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "validation" } });

    await expect(
      svc.updateStage({
        companyId: company.id,
        pipelineId: pipeline.id,
        stageId: byKey.get("in_progress")!.id,
        patch: { config: { onEnter: { type: "run" } } },
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "validation" } });
  });

  it("holds the stage when server-evaluated acceptance fails, and releases it when it passes", async () => {
    const svc = serviceWith(stubRunner({ ok: true, detail: {} }).runner);
    const { company, pipeline, byKey } = await seedPipeline(svc);
    const missing = `/tmp/paperclip-acceptance-${randomUUID()}.txt`;

    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("intake")!.id,
      patch: { config: { acceptance: { criteria: `file_exists:${missing}` } } },
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "APE-10",
      title: "Acceptance holds",
      actor: userActor,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: created.case.version,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "acceptance_failed" } });

    const verdicts = await eventsOfType(created.case.id, "acceptance_evaluated");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.payload).toMatchObject({ ok: false, evaluatedCaseVersion: created.case.version });
    expect(await eventsOfType(created.case.id, "step_held")).toHaveLength(1);

    // The case is still in intake — the hold held.
    expect((await currentStageKey(created.case.id)).stepKey).toBe("intake");

    // Make the criteria true; the very next attempt re-evaluates, clears the
    // hold and lets the case out. No agent was ever asked.
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(missing, "done");
    try {
      await svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: (await currentStageKey(created.case.id)).version,
        actor: userActor,
      });
    } finally {
      await rm(missing, { force: true });
    }
    expect((await currentStageKey(created.case.id)).stepKey).toBe("in_progress");
    expect(await eventsOfType(created.case.id, "step_hold_cleared")).toHaveLength(1);
  });

  it("spends ZERO tokens: no routine, no agent, no heartbeat run on either path", async () => {
    const { runner, workflowCalls } = stubRunner({ ok: true, detail: { status: "success" } });
    const svc = serviceWith(runner);
    const { company, pipeline, byKey } = await seedPipeline(svc);
    const present = `/tmp/paperclip-acceptance-${randomUUID()}.txt`;
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(present, "done");

    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          onEnter: { type: "run", target: { type: "workflow", workflow: "open-pr" } },
          acceptance: { criteria: `file_exists:${present}` },
        },
      },
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "APE-11",
      title: "Zero token",
      actor: userActor,
    });
    try {
      await svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: created.case.version,
        actor: userActor,
      });
      await svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "review",
        expectedVersion: (await currentStageKey(created.case.id)).version,
        actor: userActor,
      });
    } finally {
      await rm(present, { force: true });
    }

    expect(workflowCalls).toHaveLength(1);
    expect((await currentStageKey(created.case.id)).stepKey).toBe("review");
    // Nothing that costs tokens was created by any of it.
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    expect(await db.select().from(routineRuns)).toHaveLength(0);
    expect(await db.select().from(routines)).toHaveLength(0);
    expect(await db.select().from(agents)).toHaveLength(0);
    expect(await db.select().from(issues)).toHaveLength(0);
  });
});
