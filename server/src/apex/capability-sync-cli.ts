/**
 * CapabilitySyncCliClient — shells the top-level `apex capabilities sync`
 * CLI: `apex --output json capabilities sync` (a GROUP-level `--output`
 * flag, placed before the `capabilities` group — NOT
 * `capabilities sync --output json` the way `workflows-cli.ts` places it
 * after the leaf subcommand; the two CLI groups document different flag
 * placement and this client matches `capabilities`'s).
 *
 * Built (spec: capability sync + PATH-canonical resolution, Session B / T4)
 * against Session A's T1 CLI contract while that CLI lands on a separate,
 * still-unmerged branch — same "the CLI doesn't recognize this command yet
 * is an everyday condition" posture as `workflows-cli.ts`, and the same
 * `cli_missing_command` classification for it.
 *
 * Parsing: `apex capabilities sync` clones/copies files and may write
 * human progress to stdout ahead of its final JSON summary (unlike
 * `workflows list`/`show`, which are pure data commands with nothing else to
 * report) — so this parses the LAST line of stdout that is valid JSON,
 * scanning from the end, rather than assuming the entire trimmed stdout is
 * one JSON blob.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CapabilitySyncSuccessSchema,
  type CapabilitySyncError,
  type CapabilitySyncSuccess,
} from "@paperclipai/shared";
import { run } from "./exec.js";

export type CapabilitySyncCliResult =
  | { ok: true; data: CapabilitySyncSuccess }
  | { ok: false; error: CapabilitySyncError };

const UNRELEASED_MESSAGE = "requires apex-core with the capabilities CLI (unreleased)";

function degradedCliError(remediation: string): CapabilitySyncError {
  return {
    status: "error",
    error_type: "cli_missing_command",
    message: UNRELEASED_MESSAGE,
    remediation,
  };
}

/** Scans stdout from the last line backward for the first line that parses
 *  as JSON — `apex capabilities sync`'s documented convention is a single
 *  JSON summary as its LAST line of stdout, with any progress output
 *  (clone/copy/divergence chatter) on earlier lines. Returns null if no
 *  line parses. */
export function parseLastJsonLine(stdout: string): unknown | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

export class CapabilitySyncCliClient {
  constructor(
    private readonly bin: string = process.env.APEX_BIN ?? "apex",
    private readonly timeoutMs: number = 60_000,
    // Same launch-dir convention as CliApexInvoker/WorkflowsCliClient:
    // enablement config (capability_sources, etc.) lives in a dedicated home
    // folder, not any repo's.
    private readonly cwd: string = process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit"),
  ) {}

  /**
   * Runs `apex --output json capabilities sync`. `companySlug`, when given,
   * sets `APEX_COMPANY_SLUG` in the child env — per-company-slug env vars
   * (`APEX_<SLUG>_WORKFLOWS_PATH`/`APEX_<SLUG>_SKILLS_PATH`) only expand for
   * the company selected this way (amendment: per-company env vars). The
   * sync job itself stays company-agnostic (syncs every configured source
   * regardless), so this is a pass-through for callers that want a
   * company-scoped run; the scheduled tick omits it.
   */
  async sync(opts: { companySlug?: string; dryRun?: boolean; acceptSkills?: boolean } = {}): Promise<CapabilitySyncCliResult> {
    const args = ["--output", "json", "capabilities", "sync"];
    if (opts.dryRun) args.push("--dry-run");
    if (opts.acceptSkills) args.push("--accept-skills");

    const env = opts.companySlug ? { APEX_COMPANY_SLUG: opts.companySlug } : undefined;
    const res = await run(this.bin, args, this.timeoutMs, this.cwd, env);

    if (res.status === "missing") {
      return {
        ok: false,
        error: degradedCliError(`Install the apex-core build that ships \`capabilities sync\`, then ensure \`${this.bin}\` is on PATH.`),
      };
    }

    // Success and the CLI's own classified error (not_configured /
    // clone_failed / ...) both land in the same JSON envelope on stdout,
    // even on a non-zero exit (same convention CliApexInvoker and
    // WorkflowsCliClient rely on) — parse the last JSON line first, branch
    // on `status`, and only fall back to the degraded classification when
    // nothing on stdout parses as the documented shape at all.
    const parsed = parseLastJsonLine(res.stdout);
    if (parsed === null || typeof parsed !== "object" || !("status" in parsed)) {
      return {
        ok: false,
        error: degradedCliError(
          "Merge/install the apex-core build that ships `apex capabilities sync` — the installed CLI didn't return the documented JSON contract for this command.",
        ),
      };
    }

    const status = (parsed as { status?: unknown }).status;
    if (status === "error") {
      const p = parsed as { error_type?: unknown; message?: unknown; remediation?: unknown };
      return {
        ok: false,
        error: {
          status: "error",
          error_type: typeof p.error_type === "string" ? p.error_type : "cli_failed",
          message: typeof p.message === "string" ? p.message : "apex capabilities sync failed.",
          remediation: typeof p.remediation === "string" ? p.remediation : null,
        },
      };
    }
    if (status !== "success") {
      return { ok: false, error: degradedCliError("Merge/install the apex-core build that ships `apex capabilities sync`.") };
    }

    const validated = CapabilitySyncSuccessSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        error: {
          status: "error",
          error_type: "parse_failed",
          message: "apex capabilities sync returned an unexpected shape.",
          remediation: null,
        },
      };
    }
    return { ok: true, data: validated.data };
  }
}
