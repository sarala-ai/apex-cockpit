/**
 * The hands of a `run` step — the deterministic kind, the one that costs
 * nothing (docs/architecture/process-definition.md §2a). Both target types
 * shell the apex CLI (`apex --output json run …`) and read results through one
 * envelope parser, so parsing and classification stay in one place.
 *
 * Execution-mode doctrine: a process definition IS the approved plan, so this
 * runner — and only this runner — opts a workflow target into apply
 * (`--execution-mode apply`) and a command target into real execution
 * (`APEX_EXECUTION_MODE=apply` for the invocation). Nothing else in the
 * cockpit escalates past dry-run.
 *
 * Honest v1 simplification (documented, not hidden): a command target's `tool`
 * must name its resource server as "<server> <tool>" (e.g.
 * "health generate_health_report"). Bare tool names — the placeholder
 * `ci_status_check` style the seeded lifecycles still carry from their YAML
 * ancestors — are classified unresolvable and routed through the step's
 * `on_fail`, never guessed at.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run } from "../exec.js";
import { ApexUnavailableError } from "../invoke.js";

/**
 * The CLI envelope itself: `status` here is the AUTHORITATIVE execution
 * signal (exit code mirrors it). `result` is the tool's own payload — its
 * `status` field (when present) is domain-specific ("healthy", "passed",
 * or a nested workflow run's "success"/"failed") and must NOT be conflated
 * with the envelope status. The acceptance run caught exactly that bug:
 * a healthy health-report read as a failed check under naive flattening.
 */
const cliEnvelopeSchema = z
  .object({
    status: z.string(),
    error: z.string().optional(),
    error_type: z.string().optional(),
    message: z.string().optional(),
    result: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type NodeExecutionResult =
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; errorType: string; message: string };

/**
 * The two things a `run` step can target (docs/architecture/process-definition.md
 * §2a). They are targets, not step kinds: whether a step shells an APEX
 * workflow or another command is an implementation detail of the target, not a
 * fact about the process. Adding a third target later is one registration here,
 * not a new kind rippling through the executor, the UI, the schema and every
 * seeded definition.
 *
 * `pass_criteria` is deliberately absent from `runCommand`. It used to ride
 * along on a check node and was never evaluated as an expression; it is now the
 * step's `acceptance` contract, which the server actually evaluates and which
 * refuses criteria it cannot check. One criteria concept, in the place that
 * enforces it.
 */
export interface StepTargetRunner {
  runWorkflow(config: { workflow: string; params: Record<string, unknown> }): Promise<NodeExecutionResult>;
  runCommand(config: { tool: string; args: string[] }): Promise<NodeExecutionResult>;
}

/** Tracing identifiers forwarded into each CLI child's environment so
 *  core-side telemetry and audit entries join back to the dispatching step. */
export interface StepDispatchContext {
  caseId: string;
  stepKey: string;
  runId: string;
}

const toDash = (s: string): string => s.replace(/_/g, "-");

export class CliStepTargetRunner implements StepTargetRunner {
  constructor(
    private readonly bin: string = process.env.APEX_BIN ?? "apex",
    private readonly cwd: string = process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit"),
    /** Workflow nodes run real deploys — give them room. */
    private readonly workflowTimeoutMs: number = 15 * 60_000,
    private readonly checkTimeoutMs: number = 5 * 60_000,
    private readonly dispatchContext?: StepDispatchContext,
  ) {}

  async runWorkflow(config: { workflow: string; params: Record<string, unknown> }): Promise<NodeExecutionResult> {
    const args = [
      "--output",
      "json",
      "run",
      "workflow",
      "run",
      "--workflow",
      config.workflow,
      "--execution-mode",
      "apply",
    ];
    if (config.params && Object.keys(config.params).length > 0) {
      // `params` is object-typed in the tool config; the CLI parses JSON.
      args.push("--params", JSON.stringify(config.params));
    }
    // The workflow engine reports its own run status in the payload — a
    // failed workflow inside a successful CLI call must still fail the node.
    return this.execute(args, `workflow run ${config.workflow}`, undefined, {
      requireInnerRunSuccess: true,
    });
  }

  async runCommand(config: { tool: string; args: string[] }): Promise<NodeExecutionResult> {
    const tokens = config.tool.trim().split(/\s+/);
    if (tokens.length !== 2) {
      return {
        ok: false,
        errorType: "command_tool_unresolvable",
        message:
          `command tool ${JSON.stringify(config.tool)} is not resolvable — v1 requires ` +
          `"<server> <tool>" naming a real resource server tool (e.g. "health generate_health_report").`,
      };
    }
    const [server, tool] = tokens as [string, string];
    const args = ["--output", "json", "run", server, toDash(tool), ...config.args];
    // A command step must be REAL to mean anything: opt this invocation into
    // apply so the tool executes instead of returning a dry-run simulation.
    return this.execute(args, `command ${server} ${tool}`, { APEX_EXECUTION_MODE: "apply" });
  }

  private contextEnv(): NodeJS.ProcessEnv {
    if (!this.dispatchContext) return {};
    return {
      APEX_CASE_ID: this.dispatchContext.caseId,
      APEX_STEP_KEY: this.dispatchContext.stepKey,
      APEX_RUN_ID: this.dispatchContext.runId,
    };
  }

  private async execute(
    args: string[],
    what: string,
    env: NodeJS.ProcessEnv | undefined,
    options: { requireInnerRunSuccess?: boolean } = {},
  ): Promise<NodeExecutionResult> {
    const timeoutMs = what.startsWith("workflow") ? this.workflowTimeoutMs : this.checkTimeoutMs;
    const merged = { ...this.contextEnv(), ...(env ?? {}) };
    const res = await run(this.bin, args, timeoutMs, this.cwd, Object.keys(merged).length > 0 ? merged : undefined);
    if (res.status === "missing") {
      throw new ApexUnavailableError(`apex CLI not found (bin: ${this.bin})`);
    }
    // Failed runs still carry the classified envelope on stdout — parse it
    // either way so the classification survives (never a bare stderr slice
    // unless stdout genuinely isn't an envelope).
    let envelope: z.infer<typeof cliEnvelopeSchema>;
    try {
      envelope = cliEnvelopeSchema.parse(JSON.parse(res.stdout));
    } catch (err) {
      if (res.status === "failed") {
        return {
          ok: false,
          errorType: "apex_invocation_failed",
          message: `apex ${what} failed (code ${res.code}): ${res.stderr.slice(0, 500)}`,
        };
      }
      return {
        ok: false,
        errorType: "apex_output_contract_violation",
        message: `apex ${what} returned unparseable output: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (envelope.status !== "success") {
      return {
        ok: false,
        errorType: envelope.error_type ?? (envelope.status === "blocked" ? "blocked" : "tool_failed"),
        message:
          envelope.error ??
          envelope.message ??
          `apex ${what} reported status ${JSON.stringify(envelope.status)}`,
      };
    }
    const inner = envelope.result ?? {};
    if (options.requireInnerRunSuccess) {
      const innerStatus = typeof inner.status === "string" ? inner.status : null;
      if (innerStatus !== null && innerStatus !== "success") {
        const lastError = typeof inner.last_error === "string" ? inner.last_error : null;
        return {
          ok: false,
          errorType: "workflow_failed",
          message:
            lastError ??
            `apex ${what}: workflow run reported status ${JSON.stringify(innerStatus)}` +
              (Array.isArray(inner.steps_failed) && inner.steps_failed.length > 0
                ? ` (failed steps: ${(inner.steps_failed as string[]).join(", ")})`
                : ""),
        };
      }
    }
    return { ok: true, detail: summarize(inner) };
  }
}

function summarize(inner: Record<string, unknown>): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const key of ["status", "instance_name", "workflow_name", "steps_completed", "steps_failed", "message"]) {
    if (inner[key] !== undefined) detail[key] = inner[key];
  }
  return detail;
}
