/**
 * Flow definitions — consumed via the apex CLI, never by parsing core's YAML.
 *
 * The producer-owns seam (apex-core `flows-cli`): `apex flows show <name>
 * --output json` emits the parsed, validated FlowDefinition; this module is
 * the cockpit's ONE place that output becomes a typed object. The zod schema
 * here mirrors apex-core's pydantic flow_models (four node kinds, implicit
 * linear edges, on_fail pause|skip|jump:<id>) — contract drift fails loudly
 * at this seam, not silently in the coordinator.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { run } from "../exec.js";
import { ApexUnavailableError } from "../invoke.js";

export const FLOW_ON_FAIL_RE = /^(pause|skip|jump:[A-Za-z0-9_-]+)$/;

export const workflowNodeConfigSchema = z.object({
  workflow: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});

export const checkNodeConfigSchema = z.object({
  tool: z.string().min(1),
  args: z.array(z.string()).default([]),
  pass_criteria: z.string().min(1),
});

export const agentNodeConfigSchema = z.object({
  prompt_template: z.string().min(1),
  budget: z
    .object({
      max_turns: z.number().nullish(),
      max_tokens: z.number().nullish(),
      timeout_seconds: z.number().nullish(),
    })
    .partial()
    .nullish(),
  acceptance: z.string().min(1),
});

export const gateNodeConfigSchema = z.object({
  mode: z.enum(["approve", "notify"]),
  prompt: z.string().nullish(),
});

export const flowNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["workflow", "check", "agent", "gate"]),
  workflow: workflowNodeConfigSchema.nullish(),
  check: checkNodeConfigSchema.nullish(),
  agent: agentNodeConfigSchema.nullish(),
  gate: gateNodeConfigSchema.nullish(),
  on_fail: z.string().regex(FLOW_ON_FAIL_RE).default("pause"),
});

export const flowDefinitionSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
  description: z.string(),
  ticket_type: z.string(),
  nodes: z.array(flowNodeSchema).min(1),
});

export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;

const flowShowSuccessSchema = z.object({
  status: z.literal("success"),
  path: z.string(),
  flow: flowDefinitionSchema,
});

const flowListSuccessSchema = z.object({
  status: z.literal("success"),
  flows: z.array(
    z
      .object({
        name: z.string(),
        path: z.string(),
        version: z.string().optional(),
        ticket_type: z.string().optional(),
        description: z.string().optional(),
        node_count: z.number().optional(),
        gate_count: z.number().optional(),
        error: z.string().optional(),
        error_type: z.string().optional(),
      })
      .passthrough(),
  ),
});

/** The CLI's classified error envelope (`{status:"error", error_type, error}`). */
const flowErrorEnvelopeSchema = z.object({
  status: z.literal("error"),
  error_type: z.string(),
  error: z.string(),
});

export type LoadedFlowDefinition = { path: string; flow: FlowDefinition };
export type FlowListRow = z.infer<typeof flowListSuccessSchema>["flows"][number];

/** A classified flow-definition failure (not_found | invalid_flow | contract). */
export class FlowDefinitionError extends Error {
  constructor(
    message: string,
    readonly errorType: string,
  ) {
    super(message);
    this.name = "FlowDefinitionError";
  }
}

function apexBin(): string {
  return process.env.APEX_BIN ?? "apex";
}

function apexCwd(): string {
  return process.env.APEX_LAUNCH_DIR ?? join(homedir(), ".apex-cockpit");
}

/** The apex CLI needs its full platform setup before dispatching any command
 *  (~10–20s cold on this codebase) — a plain tool timeout is too tight. */
const FLOW_CLI_TIMEOUT_MS = 60_000;

async function runFlowsCommand<T>(
  args: string[],
  // Structural parser type (not z.ZodType<T>): inference must bind T to the
  // schema's OUTPUT type — with defaults in play, z.ZodType<T> lets TS unify
  // T with the input type where `on_fail` is still optional.
  schema: { parse: (value: unknown) => T },
  what: string,
): Promise<T> {
  const res = await run(apexBin(), ["--output", "json", "flows", ...args], FLOW_CLI_TIMEOUT_MS, apexCwd());
  if (res.status === "missing") {
    throw new ApexUnavailableError(`apex CLI not found (bin: ${apexBin()})`);
  }
  if (res.status === "failed") {
    // The CLI writes its classified error envelope to stdout, then exits 1 —
    // surface that classification instead of a generic stderr slice.
    const classified = tryParseErrorEnvelope(res.stdout);
    if (classified) {
      throw new FlowDefinitionError(classified.error, classified.error_type);
    }
    throw new FlowDefinitionError(
      `apex flows ${what} failed (code ${res.code}): ${res.stderr.slice(0, 500)}`,
      "flow_cli_failed",
    );
  }
  try {
    return schema.parse(JSON.parse(res.stdout));
  } catch (err) {
    throw new FlowDefinitionError(
      `apex flows ${what} output violated the flow contract: ${err instanceof Error ? err.message : String(err)}`,
      "flow_contract_violation",
    );
  }
}

function tryParseErrorEnvelope(stdout: string): z.infer<typeof flowErrorEnvelopeSchema> | null {
  try {
    return flowErrorEnvelopeSchema.parse(JSON.parse(stdout));
  } catch {
    return null;
  }
}

/** Load one flow definition by name via `apex flows show <name> --output json`. */
export async function loadFlowDefinition(name: string): Promise<LoadedFlowDefinition> {
  const out = await runFlowsCommand(["show", name], flowShowSuccessSchema, `show ${name}`);
  return { path: out.path, flow: out.flow };
}

/** List flows visible to the apex install via `apex flows list --output json`. */
export async function listFlowDefinitions(): Promise<FlowListRow[]> {
  const out = await runFlowsCommand(["list"], flowListSuccessSchema, "list");
  return out.flows;
}
