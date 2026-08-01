/**
 * WorkflowsCliClient — shells the top-level `apex workflows` CLI directly
 * (NOT `apex run <server> <tool>`, see invoke.ts's CliApexInvoker for that
 * shape): `apex --output json workflows list` / `apex --output json workflows
 * show <name>` (--output is a GROUP-level option — verified live: placing it
 * after the subcommand is silently rejected), per the documented contract (see @paperclipai/shared's
 * workflows.ts for the exact schema).
 *
 * This is Part 2 of the Workflows migration, consumed against a live CLI
 * whose Part 1 (the `workflows` subcommand itself) is still unmerged. That
 * makes "the CLI doesn't recognize this command yet" an expected, everyday
 * condition — not an edge case — so it gets a first-class classification
 * (`cli_missing_command`) rather than falling out as a generic failure. The
 * signal we use: on a released CLI, EVERY outcome (success or the tool's own
 * error) is the documented JSON envelope on stdout; anything that isn't
 * (missing binary, non-JSON stdout, an unrecognized-subcommand message) means
 * the installed CLI predates the workflows command.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  WorkflowDetailSuccessSchema,
  WorkflowListSuccessSchema,
  type WorkflowDetailSuccess,
  type WorkflowError,
  type WorkflowListSuccess,
} from "@paperclipai/shared";
import { run } from "./exec.js";

export type WorkflowsCliResult<T> = { ok: true; data: T } | { ok: false; error: WorkflowError };

const UNRELEASED_MESSAGE = "requires apex-platform with the workflows CLI (unreleased)";

function degradedCliError(remediation: string): WorkflowError {
  return {
    status: "error",
    error_type: "cli_missing_command",
    message: UNRELEASED_MESSAGE,
    remediation,
  };
}

export class WorkflowsCliClient {
  constructor(
    private readonly bin: string = process.env.APEX_BIN ?? "apex",
    private readonly timeoutMs: number = 20_000,
    // Same launch-dir convention as CliApexInvoker (invoke.ts): enablement
    // config lives in a dedicated home folder, not any repo's.
    private readonly cwd: string = process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit"),
  ) {}

  private async invoke(
    args: string[],
    companySlug?: string,
  ): Promise<{ ok: true; json: unknown } | { ok: false; error: WorkflowError }> {
    // Amendment (per-company env vars): the resolver's company-scoped path
    // entries (APEX_<SLUG>_WORKFLOWS_PATH / APEX_<SLUG>_SKILLS_PATH) only
    // expand for the company selected via APEX_COMPANY_SLUG on THIS
    // invocation — core stays company-ignorant (pure env-name indirection).
    // Omitted (companySlug undefined) reproduces today's behavior exactly:
    // repo > user (~/.apex) > bundled, no company layers.
    const env = companySlug ? { APEX_COMPANY_SLUG: companySlug } : undefined;
    const res = await run(this.bin, args, this.timeoutMs, this.cwd, env);

    if (res.status === "missing") {
      return {
        ok: false,
        error: degradedCliError(`Install the apex-platform build that ships the workflows CLI, then ensure \`${this.bin}\` is on PATH.`),
      };
    }

    // Success and the CLI's OWN classified error both land on stdout as one
    // JSON object, even on a non-zero exit (same convention CliApexInvoker
    // relies on) — parse first, branch on `status`, and only fall back to the
    // degraded classification when stdout isn't that documented shape at all.
    let parsed: unknown;
    try {
      // The apex CLI prints human startup noise BEFORE the JSON envelope
      // (verified live: "✅ Loaded server definition ..." lines precede the
      // object) — same reality CliApexInvoker handles by taking the LAST
      // JSON-looking line. Parse that, not the whole stdout.
      const lines = res.stdout.split("\n").filter((l) => l.trim().length > 0);
      const lastJson = [...lines].reverse().find((l) => {
        const t = l.trim();
        return t.startsWith("{") && t.endsWith("}");
      });
      parsed = JSON.parse(lastJson ?? res.stdout);
    } catch {
      return {
        ok: false,
        error: degradedCliError(
          "Merge/install the apex-platform build that ships `apex workflows` — the installed CLI didn't return the documented JSON contract for this command.",
        ),
      };
    }

    if (!parsed || typeof parsed !== "object" || !("status" in parsed)) {
      return { ok: false, error: degradedCliError("Merge/install the apex-platform build that ships `apex workflows`.") };
    }

    const status = (parsed as { status?: unknown }).status;
    if (status === "error") {
      const p = parsed as { error_type?: unknown; message?: unknown; remediation?: unknown };
      return {
        ok: false,
        error: {
          status: "error",
          error_type: typeof p.error_type === "string" ? p.error_type : "cli_failed",
          message: typeof p.message === "string" ? p.message : "apex workflows command failed.",
          remediation: typeof p.remediation === "string" ? p.remediation : null,
        },
      };
    }
    if (status === "success") {
      return { ok: true, json: parsed };
    }
    return { ok: false, error: degradedCliError("Merge/install the apex-platform build that ships `apex workflows`.") };
  }

  async list(companySlug?: string): Promise<WorkflowsCliResult<WorkflowListSuccess>> {
    const r = await this.invoke(["--output", "json", "workflows", "list"], companySlug);
    if (!r.ok) return { ok: false, error: r.error };
    const parsed = WorkflowListSuccessSchema.safeParse(r.json);
    if (!parsed.success) {
      return {
        ok: false,
        error: { status: "error", error_type: "parse_failed", message: "apex workflows list returned an unexpected shape.", remediation: null },
      };
    }
    return { ok: true, data: parsed.data };
  }

  async show(name: string, companySlug?: string): Promise<WorkflowsCliResult<WorkflowDetailSuccess>> {
    const r = await this.invoke(["--output", "json", "workflows", "show", name], companySlug);
    if (!r.ok) return { ok: false, error: r.error };
    const parsed = WorkflowDetailSuccessSchema.safeParse(r.json);
    if (!parsed.success) {
      return {
        ok: false,
        error: { status: "error", error_type: "parse_failed", message: "apex workflows show returned an unexpected shape.", remediation: null },
      };
    }
    return { ok: true, data: parsed.data };
  }
}
