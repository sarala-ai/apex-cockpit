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
import { z } from "zod";

/**
 * Turn a raw APEX tool result into a validated, typed value.
 * @param raw  a JSON string (CLI `--output json`) OR an MCP result object OR an
 *             already-parsed plain object.
 * @throws SyntaxError on malformed JSON; ZodError on contract mismatch (the point:
 *         a contract violation fails loudly here, not silently downstream in the UI).
 */
export function readApexResult<T>(raw: unknown, schema: z.ZodType<T>): T {
  const obj = typeof raw === "string" ? JSON.parse(raw) : unwrapMcpContent(raw);
  return schema.parse(obj);
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
