/**
 * Interim execution dispatch (apex-tower migration — Task 2 §2d).
 *
 * When a case enters `executing`, dispatch our `LocalRunner` — `apex run
 * <workflow>` as a subprocess — and stream its output to the fork's case log
 * surface. This is the MINIMAL/direct wiring the migration doc asks for: the
 * proper sandbox-provider plugin (a registered execution driver alongside the
 * fork's 7 providers) is the separate §5 slice and is deliberately NOT built here.
 *
 * "Log surface" here = the case's `fields.executionLog` (interleaved
 * stdout/stderr), updated via the fork's `pipelineService.patchCaseContent`, plus
 * a terminal `fields.executionStatus`. On success the case advances to the
 * `pr_review` gate (via reviewCase-independent transition); on failure it moves to
 * `failed` with the failure surfaced — never silently swallowed.
 *
 * The workflow + params come from the case fields (`workflow`, `workflowParams`)
 * if present; otherwise a single no-op `build` workflow is dispatched so the loop
 * is exercisable before the coordinator/plan slice lands.
 */

import { and, eq } from "drizzle-orm";
import { pipelineCases, type Db } from "@paperclipai/db";
import { pipelineService, type PipelineActor } from "../../services/pipelines.js";
import { LocalRunner, type ExecutionRunner } from "./runner.js";
import type { Task } from "./types.js";

export interface DispatchResult {
  ok: boolean;
  toStageKey?: string;
  /** Collected runner output (also written to the case log). */
  log: string;
  /** Failure detail when !ok — surfaced, never swallowed. */
  message?: string;
}

function taskFromCaseFields(caseId: string, fields: Record<string, unknown>): Task {
  const workflow = typeof fields.workflow === "string" && fields.workflow ? fields.workflow : "build";
  const params =
    fields.workflowParams && typeof fields.workflowParams === "object" && !Array.isArray(fields.workflowParams)
      ? (fields.workflowParams as Record<string, string>)
      : {};
  // Default to 'plan' (dry-run) for safety; 'apply' is opt-in via the case field.
  const executionMode = fields.executionMode === "apply" ? "apply" : "plan";
  // Provider (e.g. 'gcp') selects which apex resource-servers load, cwd-independent.
  const provider = typeof fields.provider === "string" && fields.provider ? fields.provider : undefined;
  return { id: caseId, title: `execute ${workflow}`, workflow, params, executionMode, provider, status: "pending" };
}

export class ExecDispatcher {
  constructor(private readonly runner: ExecutionRunner = new LocalRunner()) {}

  /**
   * Dispatch the case's execution workflow. Reads the case's current fields +
   * version, runs the workflow to completion collecting output, writes the log +
   * status onto the case, then transitions it to `pr_review` (ok) or `failed`.
   */
  async dispatchCase(
    db: Db,
    input: { companyId: string; caseId: string; actor?: PipelineActor },
  ): Promise<DispatchResult> {
    const svc = pipelineService(db);
    const actor: PipelineActor = input.actor ?? { type: "system" };

    const caseRow = await db
      .select({ fields: pipelineCases.fields, version: pipelineCases.version })
      .from(pipelineCases)
      .where(and(eq(pipelineCases.companyId, input.companyId), eq(pipelineCases.id, input.caseId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!caseRow) return { ok: false, log: "", message: `case ${input.caseId} not found` };
    const fields = (caseRow.fields ?? {}) as Record<string, unknown>;
    const version = caseRow.version;

    let log = "";
    const onData = (chunk: string) => {
      log += chunk;
    };

    const task = taskFromCaseFields(input.caseId, fields);
    // apex picks its provider from a project `.apex/settings.yaml` found by
    // walking up from cwd — run it in the case's workspace (its repo checkout,
    // which carries the right provider settings) when known.
    const cwd = typeof fields.workspacePath === "string" && fields.workspacePath ? fields.workspacePath : undefined;
    onData(`▶ ${task.title} (apex run workflow run --workflow ${task.workflow} --execution-mode ${task.executionMode ?? "plan"})\n`);
    const r = await this.runner.run(task, onData, cwd);

    // Persist the log + terminal status + structured result onto the case fields
    // (the fork's case log surface for this interim slice). `executionResult`
    // carries the parsed plan/apply summary (steps, resources, mode) for the UI.
    await svc.patchCaseContent({
      companyId: input.companyId,
      caseId: input.caseId,
      fields: {
        ...fields,
        executionLog: log,
        executionStatus: r.ok ? "passed" : "failed",
        ...(r.result ? { executionResult: r.result } : {}),
        ...(r.ok ? {} : { executionFailure: r.message ?? "step failed" }),
      },
      expectedVersion: version,
      actor,
    });

    // Advance: ok → pr_review gate; failure → failed. Read the fresh version
    // after the patch bumped it.
    const bumped = version + 1;
    const toStageKey = r.ok ? "pr_review" : "failed";
    await svc.transitionCase({
      companyId: input.companyId,
      caseId: input.caseId,
      toStageKey,
      expectedVersion: bumped,
      reason: r.ok ? "execution passed" : `execution failed: ${r.message ?? "step failed"}`,
      force: true,
      actor,
    });

    return { ok: r.ok, toStageKey, log, message: r.ok ? undefined : r.message };
  }
}
