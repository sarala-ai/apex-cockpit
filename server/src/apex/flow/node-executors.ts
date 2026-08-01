/**
 * Flow node executors — the coordinator's hands for W (workflow) and C (check)
 * nodes. Both shell the apex CLI (`apex --output json run …`) and read results
 * through the central `readApexResult`, so parsing/validation stay in one place.
 *
 * Execution-mode doctrine: flows are the approved plan, so the coordinator —
 * and only the coordinator — opts workflow nodes into apply
 * (`--execution-mode apply`) and check nodes into real execution
 * (`APEX_EXECUTION_MODE=apply` for the invocation). Nothing else in the
 * cockpit escalates past dry-run.
 *
 * Honest v1 simplifications (documented, not hidden):
 * - `pass_criteria` on check nodes is NOT evaluated as an expression. v1 pass
 *   = the CLI invocation succeeds (exit 0 + envelope status "success"). The
 *   criteria string is recorded in logs for the day a real evaluator ships.
 * - check `tool` must name its resource server: "<server> <tool>" (e.g.
 *   "health generate_health_report"). Bare tool names (the placeholder
 *   `ci_status_check` style in older flows) are classified unresolvable and
 *   routed through the node's on_fail — never guessed at.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run } from "../exec.js";
import { ApexUnavailableError, readApexResult } from "../invoke.js";

/** Post-envelope-flatten shape: `status` is the executed thing's own status
 *  (for `workflow run`, the inner run status — a failed workflow inside a
 *  successful CLI call still reads as failed here). */
const toolResultSchema = z
  .object({
    status: z.string(),
    error: z.string().optional(),
    error_type: z.string().optional(),
    message: z.string().optional(),
    last_error: z.unknown().optional(),
    steps_completed: z.array(z.string()).optional(),
    steps_failed: z.array(z.string()).optional(),
    instance_name: z.string().optional(),
  })
  .passthrough();

export type NodeExecutionResult =
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; errorType: string; message: string };

export interface FlowNodeRunner {
  runWorkflow(config: { workflow: string; params: Record<string, unknown> }): Promise<NodeExecutionResult>;
  runCheck(config: { tool: string; args: string[]; pass_criteria: string }): Promise<NodeExecutionResult>;
}

const toDash = (s: string): string => s.replace(/_/g, "-");

export class CliFlowNodeRunner implements FlowNodeRunner {
  constructor(
    private readonly bin: string = process.env.APEX_BIN ?? "apex",
    private readonly cwd: string = process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit"),
    /** Workflow nodes run real deploys — give them room. */
    private readonly workflowTimeoutMs: number = 15 * 60_000,
    private readonly checkTimeoutMs: number = 5 * 60_000,
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
    return this.execute(args, `workflow run ${config.workflow}`, undefined);
  }

  async runCheck(config: { tool: string; args: string[]; pass_criteria: string }): Promise<NodeExecutionResult> {
    const tokens = config.tool.trim().split(/\s+/);
    if (tokens.length !== 2) {
      return {
        ok: false,
        errorType: "check_tool_unresolvable",
        message:
          `check tool ${JSON.stringify(config.tool)} is not resolvable — v1 requires ` +
          `"<server> <tool>" naming a real resource server tool (e.g. "health generate_health_report").`,
      };
    }
    const [server, tool] = tokens as [string, string];
    const args = ["--output", "json", "run", server, toDash(tool), ...config.args];
    // Checks must be REAL to mean anything: opt this invocation into apply so
    // the devtools tool executes instead of returning a dry-run simulation.
    return this.execute(args, `check ${server} ${tool}`, { APEX_EXECUTION_MODE: "apply" });
  }

  private async execute(
    args: string[],
    what: string,
    env: NodeJS.ProcessEnv | undefined,
  ): Promise<NodeExecutionResult> {
    const timeoutMs = what.startsWith("workflow") ? this.workflowTimeoutMs : this.checkTimeoutMs;
    const res = await run(this.bin, args, timeoutMs, this.cwd, env);
    if (res.status === "missing") {
      throw new ApexUnavailableError(`apex CLI not found (bin: ${this.bin})`);
    }
    // Failed runs still carry the classified envelope on stdout — parse it
    // either way so the classification survives (never a bare stderr slice
    // unless stdout genuinely isn't an envelope).
    let flattened: z.infer<typeof toolResultSchema>;
    try {
      flattened = readApexResult(res.stdout, toolResultSchema);
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
    if (flattened.status === "success") {
      return { ok: true, detail: summarize(flattened) };
    }
    const lastError = typeof flattened.last_error === "string" ? flattened.last_error : null;
    return {
      ok: false,
      errorType: flattened.error_type ?? (flattened.status === "blocked" ? "blocked" : "tool_failed"),
      message:
        flattened.error ??
        lastError ??
        flattened.message ??
        `apex ${what} reported status ${JSON.stringify(flattened.status)}`,
    };
  }
}

function summarize(flattened: Record<string, unknown>): Record<string, unknown> {
  const detail: Record<string, unknown> = { status: flattened.status };
  for (const key of ["instance_name", "workflow_name", "steps_completed", "steps_failed", "message"]) {
    if (flattened[key] !== undefined) detail[key] = flattened[key];
  }
  return detail;
}
