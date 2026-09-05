/**
 * DocsCliClient — shells the top-level `apex docs` CLI directly (same shape
 * as server/src/apex/workflows-cli.ts's WorkflowsCliClient for `apex
 * workflows`, NOT `apex run <server> <tool>` — see invoke.ts's CliApexInvoker
 * for that shape): `apex --output json docs list|show|search|tags|related`
 * (--output is a GROUP-level option, same as workflows — placing it after the
 * subcommand is silently rejected).
 *
 * See apex/core/src/apex_core/tools/apex_docs.py for the documented CLI
 * surface this mirrors, and @paperclipai/shared's apex-docs.ts for the exact
 * response schemas.
 *
 * `apex docs` is a READ-ONLY surface with no unreleased-CLI history the way
 * `apex workflows` had — but the installed `apex` binary can still be
 * missing, older than this command, or return something that fails schema
 * validation, so the same `cli_missing_command` degradation applies: never a
 * crash, always a classified DocsError the MCP layer turns into a tool
 * error.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DocsListSuccessSchema,
  DocsRelatedSuccessSchema,
  DocsSearchSuccessSchema,
  DocsShowSuccessSchema,
  DocsTagsSuccessSchema,
  type DocsError,
  type DocsFilterInput,
  type DocsListSuccess,
  type DocsRelatedSuccess,
  type DocsSearchSuccess,
  type DocsShowSuccess,
  type DocsTagsSuccess,
} from "@paperclipai/shared";
import { run } from "./exec.js";

export type DocsCliResult<T> = { ok: true; data: T } | { ok: false; error: DocsError };

function degradedCliError(remediation: string): DocsError {
  return {
    status: "error",
    error_type: "cli_missing_command",
    message: "requires an installed apex-platform build with the `apex docs` CLI",
    remediation,
  };
}

const FILTER_FLAGS: Record<keyof DocsFilterInput, string> = {
  kind: "--kind",
  stage: "--stage",
  style: "--style",
  entity: "--entity",
  surface: "--surface",
  topic: "--topic",
  status: "--status",
  workflow: "--workflow",
};

function filterArgs(filters?: DocsFilterInput): string[] {
  if (!filters) return [];
  const args: string[] = [];
  for (const [key, flag] of Object.entries(FILTER_FLAGS) as Array<[keyof DocsFilterInput, string]>) {
    for (const value of filters[key] ?? []) {
      args.push(flag, value);
    }
  }
  return args;
}

export class DocsCliClient {
  constructor(
    private readonly bin: string = process.env.APEX_BIN ?? "apex",
    private readonly timeoutMs: number = 20_000,
    // Same launch-dir convention as WorkflowsCliClient / CliApexInvoker.
    private readonly cwd: string = process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit"),
  ) {}

  private async invoke(
    args: string[],
    companySlug?: string,
  ): Promise<{ ok: true; json: unknown } | { ok: false; error: DocsError }> {
    const env = companySlug ? { APEX_COMPANY_SLUG: companySlug } : undefined;
    const res = await run(this.bin, args, this.timeoutMs, this.cwd, env);

    if (res.status === "missing") {
      return {
        ok: false,
        error: degradedCliError(`Install the apex-platform build that ships \`apex docs\`, then ensure \`${this.bin}\` is on PATH.`),
      };
    }

    let parsed: unknown;
    try {
      // apex prints human startup noise before the JSON envelope (same
      // reality WorkflowsCliClient/CliApexInvoker handle) — take the last
      // JSON-looking line, not the whole stdout.
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
          "Merge/install the apex-platform build that ships `apex docs` — the installed CLI didn't return the documented JSON contract for this command.",
        ),
      };
    }

    if (!parsed || typeof parsed !== "object" || !("status" in parsed)) {
      return { ok: false, error: degradedCliError("Merge/install the apex-platform build that ships `apex docs`.") };
    }

    const status = (parsed as { status?: unknown }).status;
    if (status === "error") {
      const p = parsed as { error_type?: unknown; message?: unknown; remediation?: unknown };
      return {
        ok: false,
        error: {
          status: "error",
          error_type: typeof p.error_type === "string" ? p.error_type : "cli_failed",
          message: typeof p.message === "string" ? p.message : "apex docs command failed.",
          remediation: typeof p.remediation === "string" ? p.remediation : null,
        },
      };
    }
    if (status === "success") {
      return { ok: true, json: parsed };
    }
    return { ok: false, error: degradedCliError("Merge/install the apex-platform build that ships `apex docs`.") };
  }

  async list(
    filters?: DocsFilterInput,
    companySlug?: string,
  ): Promise<DocsCliResult<DocsListSuccess>> {
    const r = await this.invoke(["--output", "json", "docs", "list", ...filterArgs(filters)], companySlug);
    if (!r.ok) return { ok: false, error: r.error };
    const parsed = DocsListSuccessSchema.safeParse(r.json);
    if (!parsed.success) {
      return { ok: false, error: { status: "error", error_type: "parse_failed", message: "apex docs list returned an unexpected shape.", remediation: null } };
    }
    return { ok: true, data: parsed.data };
  }

  async show(docId: string, companySlug?: string): Promise<DocsCliResult<DocsShowSuccess>> {
    const r = await this.invoke(["--output", "json", "docs", "show", docId], companySlug);
    if (!r.ok) return { ok: false, error: r.error };
    const parsed = DocsShowSuccessSchema.safeParse(r.json);
    if (!parsed.success) {
      return { ok: false, error: { status: "error", error_type: "parse_failed", message: "apex docs show returned an unexpected shape.", remediation: null } };
    }
    return { ok: true, data: parsed.data };
  }

  async search(
    query: string,
    opts?: DocsFilterInput & { limit?: number },
    companySlug?: string,
  ): Promise<DocsCliResult<DocsSearchSuccess>> {
    const args = ["--output", "json", "docs", "search", query, ...filterArgs(opts)];
    if (opts?.limit != null) args.push("--limit", String(opts.limit));
    const r = await this.invoke(args, companySlug);
    if (!r.ok) return { ok: false, error: r.error };
    const parsed = DocsSearchSuccessSchema.safeParse(r.json);
    if (!parsed.success) {
      return { ok: false, error: { status: "error", error_type: "parse_failed", message: "apex docs search returned an unexpected shape.", remediation: null } };
    }
    return { ok: true, data: parsed.data };
  }

  async tags(companySlug?: string): Promise<DocsCliResult<DocsTagsSuccess>> {
    const r = await this.invoke(["--output", "json", "docs", "tags"], companySlug);
    if (!r.ok) return { ok: false, error: r.error };
    const parsed = DocsTagsSuccessSchema.safeParse(r.json);
    if (!parsed.success) {
      return { ok: false, error: { status: "error", error_type: "parse_failed", message: "apex docs tags returned an unexpected shape.", remediation: null } };
    }
    return { ok: true, data: parsed.data };
  }

  async related(docId: string, companySlug?: string): Promise<DocsCliResult<DocsRelatedSuccess>> {
    const r = await this.invoke(["--output", "json", "docs", "related", docId], companySlug);
    if (!r.ok) return { ok: false, error: r.error };
    const parsed = DocsRelatedSuccessSchema.safeParse(r.json);
    if (!parsed.success) {
      return { ok: false, error: { status: "error", error_type: "parse_failed", message: "apex docs related returned an unexpected shape.", remediation: null } };
    }
    return { ok: true, data: parsed.data };
  }
}
