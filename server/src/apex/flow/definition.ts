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
  // Tolerant, not contractual: apex-core's flow_models.AgentNodeConfig
  // (pydantic) does not carry a `permissions` field yet — this is read
  // defensively (server/src/apex/flow/run-policy.ts derives a policy from
  // whatever shape shows up, garbage-in tolerated) rather than trusted. Core
  // follow-up: add `permissions: {profile: str}` to AgentNodeConfig so
  // `apex flows show` actually emits this key once flow YAML authors declare
  // it — until then this field is only ever populated by hand-testing raw
  // JSON, never by the real CLI.
  permissions: z.unknown().nullish(),
});

export const gateNodeConfigSchema = z.object({
  mode: z.enum(["approve", "notify"]),
  prompt: z.string().nullish(),
  /** Review-pass identifiers this gate asks the approver
   *  (apex-core `flows/*.yml` `gate.requires`; vocabulary and question text
   *  both live in core's review_passes.py — never restated here). Tolerant of
   *  an older apex-core that does not emit the key at all. */
  requires: z.array(z.string()).nullish(),
  /** Where a `request_changes` decision at this gate sends the work back to —
   *  the flow analogue of a pipeline review stage's `requestChangesToStageKey`
   *  (server/src/services/pipelines.ts), named the same way so there is ONE
   *  mental model across both subsystems.
   *
   *  Tolerant, not contractual (same posture as `agent.permissions`):
   *  apex-core's flow_models.GateNodeConfig does not emit this key yet, so in
   *  practice the target is DERIVED (see `findChangeRequestTarget`). Core
   *  follow-up: add `request_changes_to: str | None` to GateNodeConfig so flow
   *  authors can name a target explicitly. */
  request_changes_to: z.string().nullish(),
});

/** One review pass as apex-core defines it — id, label, persona, and the ONE
 *  question shown at the gate. The cockpit renders this text; it never
 *  authors it (docs/architecture/review-passes.md is the single source). */
export const reviewPassSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  persona: z.string(),
  question: z.string().min(1),
});

export type ReviewPass = z.infer<typeof reviewPassSchema>;

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

export type ChangeRequestTarget =
  | { found: true; node: FlowNode; index: number; source: "declared" | "derived" }
  | { found: false; reason: "no_prior_agent_node" | "declared_target_missing" | "declared_target_not_agent" };

/**
 * Where a `request_changes` decision at `gateNodeId` sends the work back to —
 * the flow analogue of `targetStageKeyForReviewDecision(config, "request_changes")`
 * in server/src/services/pipelines.ts.
 *
 * Lives here, not in the coordinator, because two surfaces must agree: the
 * coordinator (which re-arms the node) and the decision brief (which tells the
 * founder BEFORE they click what requesting changes will do). Divergence would
 * be a lie in the UI, so both import this.
 *
 * Resolution order, mirroring the pipelines contract:
 * 1. DECLARED — the gate's `request_changes_to`, exactly as a review stage
 *    names `requestChangesToStageKey`. A declared target that does not exist,
 *    or is not an agent node, is a classified failure rather than a silent
 *    fallback: the flow author asked for something specific.
 * 2. DERIVED — the nearest PRIOR node of kind `agent`, scanning backwards.
 *    That is the authoring step: the only node kind that turns an instruction
 *    into a fresh artifact, and therefore the only one that can act on a
 *    reviewer's comment. This default exists because apex-core does not emit
 *    `request_changes_to` yet.
 *
 * Nodes BETWEEN the target and the gate are deliberately not skipped — they
 * re-run as the flow advances forward again (implicit linear edges), so the
 * gate never reopens over work that has not passed the same automated bar.
 *
 * `no_prior_agent_node` (e.g. `feature.yml`'s `promote` gate, which is node 0)
 * means changes cannot be requested here at all; the caller must say so rather
 * than invent a target.
 */
export function findChangeRequestTarget(
  flow: FlowDefinition,
  gateNodeId: string,
): ChangeRequestTarget {
  const gateIndex = flow.nodes.findIndex((node) => node.id === gateNodeId);
  if (gateIndex < 0) return { found: false, reason: "no_prior_agent_node" };
  const declared = flow.nodes[gateIndex]?.gate?.request_changes_to?.trim();
  if (declared) {
    const index = flow.nodes.findIndex((node) => node.id === declared);
    if (index < 0) return { found: false, reason: "declared_target_missing" };
    const node = flow.nodes[index] as FlowNode;
    if (node.kind !== "agent" || !node.agent) return { found: false, reason: "declared_target_not_agent" };
    return { found: true, node, index, source: "declared" };
  }
  for (let index = gateIndex - 1; index >= 0; index -= 1) {
    const node = flow.nodes[index] as FlowNode;
    if (node.kind === "agent" && node.agent) return { found: true, node, index, source: "derived" };
  }
  return { found: false, reason: "no_prior_agent_node" };
}

const flowShowSuccessSchema = z.object({
  status: z.literal("success"),
  path: z.string(),
  flow: flowDefinitionSchema,
  /** Catalog subset for the passes this flow's gates ask for. Defaulted, so a
   *  cockpit talking to an apex-core that predates review passes still loads
   *  flows — it just has no questions to show. */
  review_passes: z.record(z.string(), reviewPassSchema).default({}),
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

export type LoadedFlowDefinition = {
  path: string;
  flow: FlowDefinition;
  reviewPasses: Record<string, ReviewPass>;
};
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
  return { path: out.path, flow: out.flow, reviewPasses: out.review_passes };
}

/** List flows visible to the apex install via `apex flows list --output json`. */
export async function listFlowDefinitions(): Promise<FlowListRow[]> {
  const out = await runFlowsCommand(["list"], flowListSuccessSchema, "list");
  return out.flows;
}
