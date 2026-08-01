/**
 * WorkflowValidateCliClient — shells `apex validate --workflow <tmp-file>
 * --json` (validate's OWN `--json` flag; NOT the `workflows` subcommand's
 * group-level `--output json` convention documented in workflows-cli.ts —
 * verified live in apex-core's apex_validate.py: `--json` is a command-level
 * `click.option`, declared on `validate_command` itself).
 *
 * Unlike the `workflows` CLI (Part 1 unmerged as of its route landing),
 * `apex validate` already ships — see apex-core's
 * src/apex_platform/tools/apex_validate.py. So the everyday degraded case
 * here is "no `apex` binary on PATH", not "installed CLI predates this
 * command"; a not-JSON-shaped stdout still degrades rather than crashing,
 * in case of a stale installed CLI or a build that changed the contract.
 *
 * The caller always gets the workflow YAML as a string (it hasn't been
 * saved to a file yet — that's the point of a pre-save validate endpoint),
 * so this client owns writing it to a temp file and cleaning that file up,
 * success or failure.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowValidateSuccessSchema,
  type WorkflowError,
  type WorkflowValidateSuccess,
} from "@paperclipai/shared";
import { run } from "./exec.js";

export type WorkflowValidateCliResult =
  | { ok: true; data: WorkflowValidateSuccess }
  | { ok: false; error: WorkflowError };

function degradedError(message: string, remediation: string): WorkflowError {
  return { status: "error", error_type: "cli_missing", message, remediation };
}

/** Shape of one issue in the CLI's raw `_print_json` envelope. */
interface RawIssue {
  severity?: unknown;
  message?: unknown;
  tool?: unknown;
  suggestion?: unknown;
}
interface RawValidateJson {
  servers?: Array<{ issues?: RawIssue[] }>;
  totals?: { errors?: unknown; warnings?: unknown };
  passed?: unknown;
}

/** Flatten the CLI's `servers[].issues[]` (see module doc) into the route's
 *  simpler `{valid, errors[], warnings[]}` shape. Tolerant of a missing or
 *  malformed `issues` array — an absent list is empty, not an error. */
function flattenValidateJson(raw: RawValidateJson): WorkflowValidateSuccess {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const server of raw.servers ?? []) {
    for (const issue of server.issues ?? []) {
      const message = typeof issue.message === "string" ? issue.message : "Unspecified validation issue.";
      if (issue.severity === "warning") warnings.push(message);
      else errors.push(message);
    }
  }
  const valid = raw.passed === true;
  return { valid, errors, warnings };
}

export class WorkflowValidateCliClient {
  constructor(
    private readonly bin: string = process.env.APEX_BIN ?? "apex",
    private readonly timeoutMs: number = 20_000,
    // Same launch-dir convention as WorkflowsCliClient/CliApexInvoker.
    private readonly cwd: string = process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit"),
  ) {}

  async validate(yaml: string): Promise<WorkflowValidateCliResult> {
    // A dedicated per-call temp DIRECTORY (not just a temp file) so cleanup is
    // a single `rm -rf` with nothing else in it to worry about colliding with.
    const workDir = join(tmpdir(), `apex-validate-${randomUUID()}`);
    const filePath = join(workDir, "workflow.yaml");
    await mkdir(workDir, { recursive: true });
    try {
      await writeFile(filePath, yaml, "utf8");
      return await this.runValidate(filePath);
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runValidate(filePath: string): Promise<WorkflowValidateCliResult> {
    const res = await run(this.bin, ["validate", "--workflow", filePath, "--json"], this.timeoutMs, this.cwd);

    if (res.status === "missing") {
      return {
        ok: false,
        error: degradedError(
          "The `apex` CLI is not installed or not on PATH.",
          "Install apex-platform, then ensure `apex` is on PATH.",
        ),
      };
    }

    // Both success and a validation failure (invalid workflow) print the JSON
    // envelope on stdout — `apex validate` only exits non-zero when the
    // workflow itself fails validation, which is an ordinary `valid: false`
    // result here, not a degraded CLI. Only a missing/unparseable envelope is
    // degraded.
    let parsed: unknown;
    try {
      const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
      const lastJson = [...lines].reverse().find((l) => {
        const t = l.trim();
        return t.startsWith("{") && t.endsWith("}");
      });
      parsed = JSON.parse(lastJson ?? res.stdout);
    } catch {
      return {
        ok: false,
        error: degradedError(
          "`apex validate --json` did not return the documented JSON contract.",
          "Update apex-platform to a build that supports `apex validate --workflow <file> --json`.",
        ),
      };
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        ok: false,
        error: degradedError(
          "`apex validate --json` returned an unexpected shape.",
          "Update apex-platform to a build that supports `apex validate --workflow <file> --json`.",
        ),
      };
    }

    const data = flattenValidateJson(parsed as RawValidateJson);
    const check = WorkflowValidateSuccessSchema.safeParse(data);
    if (!check.success) {
      return {
        ok: false,
        error: degradedError(
          "`apex validate --json` output failed schema validation.",
          "Update apex-platform to a build that supports `apex validate --workflow <file> --json`.",
        ),
      };
    }
    return { ok: true, data: check.data };
  }
}
