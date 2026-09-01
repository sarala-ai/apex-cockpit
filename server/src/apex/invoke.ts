/**
 * Central APEX result reader — the ONE place a result coming out of APEX becomes
 * a validated, typed JSON object.
 *
 * Motivation: components that consume APEX data (observability/monitoring above
 * all) must not each hand-parse CLI/MCP output. That fragments the output
 * contract and lets drift creep in between what APEX returns and what the UI
 * expects. Instead, every consumer calls `readApexResult(raw, schema)` (or an
 * `ApexInvoker`), so parsing + contract validation live in a single
 * implementation. The `schema` is the SAME zod schema the UI's types are inferred
 * from (see observe/contract.ts) — MCP output and UI input are validated against
 * one definition and cannot diverge.
 *
 * Two runtime paths, one reader:
 *   - CLI mode:  `apex run <server> <tool> --output json` → a JSON string on stdout.
 *   - MCP mode:  an MCP tool result object `{ content: [{ type:'text', text:'<json>' }] }`.
 * `readApexResult` accepts either and normalizes to a plain object before validating.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run } from "./exec.js";

/**
 * Turn a raw APEX tool result into a validated, typed value.
 * @param raw  a JSON string (CLI `--output json`) OR an MCP result object OR an
 *             already-parsed plain object.
 * @throws SyntaxError on malformed JSON; ZodError on contract mismatch (the point:
 *         a contract violation fails loudly here, not silently downstream in the UI).
 */
export function readApexResult<T>(raw: unknown, schema: z.ZodType<T>): T {
  const obj = typeof raw === "string" ? JSON.parse(raw) : unwrapMcpContent(raw);
  return schema.parse(unwrapCliEnvelope(obj));
}

/**
 * The apex CLI's `--output json` envelope nests the tool's payload under
 * `result` ({server, tool, tool_name, status, message?, result: {...}}) as of
 * apex-core 0.4.x (verified live; error envelopes ALSO spread error fields at
 * top level, success envelopes do not). Consumer schemas are written against
 * the tool payload itself, so flatten: keep the envelope's status (the
 * authoritative success/error signal) and spread the payload over it.
 */
function unwrapCliEnvelope(obj: unknown): unknown {
  if (obj && typeof obj === "object" && "server" in obj && "tool" in obj && "result" in obj) {
    const env = obj as { status?: unknown; result?: unknown };
    if (env.result && typeof env.result === "object" && !Array.isArray(env.result)) {
      return { status: env.status, ...(env.result as Record<string, unknown>) };
    }
  }
  return obj;
}

/**
 * MCP tool results wrap the payload in a content array
 * (`{ content: [{ type: 'text', text: '<json>' }, ...] }`). Unwrap the first text
 * part and parse it. If `raw` is already a plain object (or has no MCP envelope),
 * return it unchanged so the caller can validate it directly.
 */
export function unwrapMcpContent(raw: unknown): unknown {
  if (raw && typeof raw === "object" && "content" in raw) {
    const content = (raw as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const textPart = content.find(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === "object" &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      );
      if (textPart) return JSON.parse(textPart.text);
    }
  }
  return raw;
}

/**
 * How the cockpit invokes an APEX tool and reads its result. Pluggable so the
 * transport (CLI subprocess now, an MCP client later, or via the gateway) is a
 * single swap that no consumer sees. Every implementation MUST route its result
 * through `readApexResult` so validation stays centralized.
 *
 * The concrete `CliApexInvoker` (shelling `apex run … --output json` via the exec
 * helper) lands with the Cloud Trace store (#6), once the exact `apex run` flags
 * and output envelope are confirmed against the installed APEX version — kept out
 * of here until then so we don't hardcode an unverified command shape.
 */
export interface ApexInvoker {
  invoke<T>(
    server: string,
    tool: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T>;
}

/** Thrown when the `apex` CLI isn't installed/on PATH — a store treats this as an
 *  empty (not error) result, so the product-agent plane degrades gracefully. */
export class ApexUnavailableError extends Error {}
/** Thrown when `apex run` exits non-zero (tool error, auth, etc.). */
export class ApexInvocationError extends Error {}

const toDash = (s: string): string => s.replace(/_/g, "-");

/**
 * Invokes an APEX tool by shelling the CLI:
 *   `apex --output json run <mount> <tool-with-dashes> --flag value …`
 * The `--output json` global flag makes the CLI emit exactly one JSON object
 * (`{server, tool, status, …result}`) on success; params become `--dashed-flag
 * value` pairs (matching apex_cli's `param.replace("_","-")`). The result is
 * validated through the central `readApexResult`, so the same schema the UI is
 * typed from also validates what the CLI returns.
 *
 * `server` is the resource server's MOUNT name (e.g. "observability"), `tool` the
 * underscore tool name (e.g. "list_agent_services"). Never throws for a missing
 * binary/failed run in a way that leaks — callers catch and degrade.
 */
export class CliApexInvoker implements ApexInvoker {
  constructor(
    private readonly bin: string = process.env.APEX_BIN ?? "apex",
    private readonly timeoutMs: number = 20_000,
    // Shell apex from a dedicated home launch folder whose .apex/settings.yaml
    // enables the product-plane servers (e.g. observability) — so enablement lives
    // in home, not in any repo's config. Override with APEX_LAUNCH_DIR.
    private readonly cwd: string = process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit"),
  ) {}

  async invoke<T>(
    server: string,
    tool: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const flags: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      flags.push(`--${toDash(k)}`, String(v));
    }
    const args = ["--output", "json", "run", server, toDash(tool), ...flags];
    const res = await run(this.bin, args, this.timeoutMs, this.cwd);
    if (res.status === "missing") {
      throw new ApexUnavailableError(`apex CLI not found (bin: ${this.bin})`);
    }
    if (res.status === "failed") {
      // A non-zero exit does NOT mean the output is garbage: the CLI emits its
      // structured error envelope ({status:"error", error, error_type:
      // "auth_expired", ...}) on stdout and THEN exits 1 (verified live). That
      // envelope carries the classified, actionable message ("Authentication
      // expired. Run: gcloud auth login") — losing it to a generic
      // stderr-slice error buries exactly what the user needs. Try the
      // contract-validated parse first; only if stdout isn't a valid envelope
      // fall through to the opaque failure.
      try {
        return readApexResult(res.stdout, schema);
      } catch {
        throw new ApexInvocationError(
          `apex run ${server} ${tool} failed (code ${res.code}): ${res.stderr.slice(0, 500)}`,
        );
      }
    }
    return readApexResult(res.stdout, schema);
  }
}
