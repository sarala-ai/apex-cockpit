/**
 * APEX-38 — lifecycle check/deploy steps must name the CONTRACT, never the
 * tool.
 *
 * The seeded feature lifecycle's `task_checks` step runs `pytest tests/unit`
 * and its `deploy` step runs the `cloud_run_deploy` workflow — hardcoded
 * regardless of the project's stack. For a Node project (vitest, no Cloud Run
 * deploy) both are wrong: a feature case would fail checks on TOOL MISMATCH,
 * not on the work.
 *
 * The contract these tests pin:
 *  - the seeded lifecycle declares WHAT must be true ("checks pass",
 *    "deployed") as a `contract` run target;
 *  - the concrete tool resolves at DISPATCH time from the project's own
 *    workspace config (`checkCommand` / `deployWorkflow`);
 *  - a project that declares no deploy workflow HOLDS the deploy step with an
 *    honest classified failure instead of invoking a deploy it never declared.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
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
import { LIFECYCLE_DEFINITIONS } from "../apex/pipeline/lifecycles.ts";

/** The onEnter target a seeded lifecycle stage declares, untyped on purpose —
 *  the assertion below is about its SHAPE. */
function seededTarget(lifecycleKey: string, stageKey: string): Record<string, unknown> {
  const definition = LIFECYCLE_DEFINITIONS.find((d) => d.key === lifecycleKey);
  if (!definition) throw new Error(`no seeded lifecycle ${lifecycleKey}`);
  const stage = definition.stages.find((s) => s.key === stageKey);
  if (!stage) throw new Error(`no stage ${stageKey} in lifecycle ${lifecycleKey}`);
  const onEnter = (stage.config as { onEnter?: { target?: Record<string, unknown> } }).onEnter;
  if (!onEnter?.target) throw new Error(`stage ${lifecycleKey}/${stageKey} declares no run target`);
  return onEnter.target;
}

describe("seeded lifecycles name the contract, never the tool (APEX-38)", () => {
  it.each([
    ["feature", "task_checks"],
    ["bug", "tests"],
  ])("%s/%s declares a checks-pass contract, not a hardcoded pytest command", (lifecycle, stage) => {
    const target = seededTarget(lifecycle, stage);
    expect(target).toEqual({ type: "contract", contract: "checks_pass" });
  });

  it.each([
    ["feature", "deploy"],
    ["bug", "deploy"],
  ])("%s/%s declares a deployed contract, not a hardcoded cloud_run_deploy workflow", (lifecycle, stage) => {
    const target = seededTarget(lifecycle, stage);
    expect(target).toEqual({ type: "contract", contract: "deployed" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres contract-target dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("contract run targets resolve from project workspace config at dispatch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const userActor: PipelineActor = { type: "user", userId: "board-user" };
  const noopHeartbeat = { wakeup: async () => null };

  /** Records every call each way work can be shelled, so a test can assert
   *  exactly what ran — and that nothing else did. */
  function stubRunner(result: NodeExecutionResult) {
    const workflowCalls: string[] = [];
    const commandCalls: string[] = [];
    const shellCalls: Array<{ command: string; cwd: string | null }> = [];
    const runner = {
      runWorkflow: async (config: { workflow: string }) => {
        workflowCalls.push(config.workflow);
        return result;
      },
      runCommand: async (config: { tool: string }) => {
        commandCalls.push(config.tool);
        return result;
      },
      runShell: async (config: { command: string; cwd?: string | null }) => {
        shellCalls.push({ command: config.command, cwd: config.cwd ?? null });
        return result;
      },
    } as StepTargetRunner;
    return { runner, workflowCalls, commandCalls, shellCalls };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lifecycle-contract-");
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
    await db.delete(routines);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(approvals);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedProjectPipeline(
    svc: ReturnType<typeof pipelineService>,
    workspace: { checkCommand?: string | null; deployWorkflow?: string | null },
  ) {
    const [company] = await db.insert(companies).values({
      name: "Contract Co",
      issuePrefix: `S${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    }).returning();
    const [project] = await db.insert(projects).values({
      companyId: company!.id,
      name: "Cockpit",
    }).returning();
    await db.insert(projectWorkspaces).values({
      companyId: company!.id,
      projectId: project!.id,
      name: "cockpit",
      sourceType: "local_path",
      cwd: "/srv/cockpit",
      isPrimary: true,
      ...workspace,
    });
    const pipeline = await svc.createPipeline({
      companyId: company!.id,
      key: `contract-${randomUUID().slice(0, 8)}`,
      name: "Contract",
      projectId: project!.id,
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

  it("runs the project's configured check command at a checks-pass contract stage", async () => {
    const { runner, shellCalls, commandCalls } = stubRunner({ ok: true, detail: { status: "success" } });
    const svc = pipelineService(db, { heartbeat: noopHeartbeat, stepRunner: runner });
    const { company, pipeline, byKey } = await seedProjectPipeline(svc, {
      checkCommand: "npm test",
    });

    // The SAME target shape the seeder emits for feature/task_checks.
    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          onEnter: {
            type: "run",
            target: seededTarget("feature", "task_checks"),
            onSuccessToStageKey: "review",
          },
        },
      },
      actor: userActor,
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "NODE-1",
      title: "Node project checks",
      actor: userActor,
    });
    const result = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: created.case.version,
      actor: userActor,
    });

    // The project's own check command ran, in the project's workspace —
    // and pytest was never guessed at.
    expect(result.automationExecution.status).toBe("succeeded");
    expect(shellCalls).toEqual([{ command: "npm test", cwd: "/srv/cockpit" }]);
    expect(commandCalls).toEqual([]);
  });

  it("HOLDS a deployed-contract stage with an honest message when the project declares no deploy workflow", async () => {
    const { runner, workflowCalls, shellCalls } = stubRunner({ ok: true, detail: { status: "success" } });
    const svc = pipelineService(db, { heartbeat: noopHeartbeat, stepRunner: runner });
    // No deployWorkflow declared — the cockpit's own honest state.
    const { company, pipeline, byKey } = await seedProjectPipeline(svc, {});

    // The SAME target shape the seeder emits for feature/deploy.
    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          onEnter: {
            type: "run",
            target: seededTarget("feature", "deploy"),
            onSuccessToStageKey: "review",
          },
        },
      },
      actor: userActor,
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "NODE-2",
      title: "No deploy declared",
      actor: userActor,
    });
    const result = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: created.case.version,
      actor: userActor,
    });

    // Nothing was invoked — cloud_run_deploy above all — and the case is held
    // on a classified, readable failure rather than a tool-mismatch crash.
    expect(result.automationExecution.status).toBe("failed");
    expect(workflowCalls).toEqual([]);
    expect(shellCalls).toEqual([]);

    const held = await eventsOfType(created.case.id, "step_held");
    expect(held).toHaveLength(1);
    expect(held[0]!.payload).toMatchObject({
      reason: "run_exit_failure",
      errorType: "deploy_workflow_not_configured",
    });

    const failed = await eventsOfType(created.case.id, "automation_failed");
    expect(failed).toHaveLength(1);
    expect(String((failed[0]!.payload as { error?: unknown }).error)).toMatch(/declares no deploy workflow/i);
  });

  it("runs the project's deploy workflow when the project DOES declare one", async () => {
    const { runner, workflowCalls } = stubRunner({ ok: true, detail: { status: "success" } });
    const svc = pipelineService(db, { heartbeat: noopHeartbeat, stepRunner: runner });
    const { company, pipeline, byKey } = await seedProjectPipeline(svc, {
      deployWorkflow: "cloud_run_deploy",
    });

    await svc.updateStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("in_progress")!.id,
      patch: {
        config: {
          onEnter: {
            type: "run",
            target: seededTarget("feature", "deploy"),
            onSuccessToStageKey: "review",
          },
        },
      },
      actor: userActor,
    });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "NODE-3",
      title: "Deploy declared",
      actor: userActor,
    });
    const result = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: created.case.version,
      actor: userActor,
    });

    expect(result.automationExecution.status).toBe("succeeded");
    expect(workflowCalls).toEqual(["cloud_run_deploy"]);
  });
});
