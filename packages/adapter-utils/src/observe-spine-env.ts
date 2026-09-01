// Correlation-spine → OpenTelemetry environment injection (EMITTER side).
//
// When the cockpit spawns a coding agent (claude-local / other acpx engines),
// the agent's own OTel telemetry must carry our correlation SPINE so its spans
// correlate back to the heartbeat run that spawned it. We do that the standard
// OTel way: set OTEL_EXPORTER_OTLP_ENDPOINT + OTEL_RESOURCE_ATTRIBUTES on the
// child process environment. The child's OTel SDK reads OTEL_RESOURCE_ATTRIBUTES
// and stamps every resource/span it emits with these attributes.
//
// GATED + ADDITIVE: when no endpoint is configured, `otelEnv` returns {} and the
// spawn behaves exactly as before. This module must never change runtime
// behavior when telemetry is off.
//
// The attribute KEYS below MIRROR the durable contract in
// `server/src/observe/contract.ts` (the `Spine` const). This package sits below
// `server` in the dependency graph and cannot import it, so the keys are
// duplicated here; `server/src/observe/spine-env.ts` re-exports this module and
// statically asserts (at typecheck time) that these keys equal `Spine`, so the
// two cannot drift.

/** Attribute keys of the correlation spine — mirror of contract.ts `Spine`. */
export const SPINE_ATTRIBUTE_KEYS = {
  orgId: "apex.org.id",
  companyId: "apex.company.id",
  projectId: "apex.project.id",
  agentId: "apex.agent.id",
  agentName: "apex.agent.name",
  agentKind: "apex.agent.kind",
  runId: "apex.run.id",
  issueId: "apex.issue.id",
  repo: "apex.repo",
  workflowName: "apex.workflow.name",
  workflowInstance: "apex.workflow.instance",
  resourceId: "apex.resource.id",
  env: "apex.env",
} as const;

/**
 * The spine values available for a run at spawn time. Every field is optional;
 * only fields with a non-empty value are emitted.
 */
export interface RunSpine {
  orgId?: string | null;
  companyId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  agentKind?: string | null;
  runId?: string | null;
  issueId?: string | null;
  repo?: string | null;
  workflowName?: string | null;
  workflowInstance?: string | null;
  resourceId?: string | null;
  env?: string | null;
}

// Order the emitted attributes deterministically (matches contract.ts order).
const SPINE_FIELD_ORDER: ReadonlyArray<keyof RunSpine> = [
  "orgId",
  "companyId",
  "projectId",
  "agentId",
  "agentName",
  "agentKind",
  "runId",
  "issueId",
  "repo",
  "workflowName",
  "workflowInstance",
  "resourceId",
  "env",
];

function normalizeValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a comma-joined `key=value` OTEL_RESOURCE_ATTRIBUTES string from a run's
 * spine, using the exact contract keys. Includes only keys whose values are
 * present. Values containing `,` or `=` are skipped (the W3C Baggage-style
 * OTEL_RESOURCE_ATTRIBUTES format is not escapable for those characters, so a
 * malformed value would corrupt the whole list) — dropping one attribute is
 * safer than poisoning the set.
 *
 * @returns the attribute string, or "" if no spine values are present.
 */
export function buildResourceAttributes(spine: RunSpine): string {
  const pairs: string[] = [];
  for (const field of SPINE_FIELD_ORDER) {
    const value = normalizeValue(spine[field]);
    if (value === null) continue;
    if (value.includes(",") || value.includes("=")) continue;
    pairs.push(`${SPINE_ATTRIBUTE_KEYS[field]}=${value}`);
  }
  return pairs.join(",");
}

/**
 * Merge spine resource attributes onto any OTEL_RESOURCE_ATTRIBUTES the caller
 * already set, preserving the caller's entries (theirs first, ours appended).
 */
export function mergeResourceAttributes(existing: string | undefined, spineAttrs: string): string {
  const left = normalizeValue(existing) ?? "";
  if (!left) return spineAttrs;
  if (!spineAttrs) return left;
  return `${left},${spineAttrs}`;
}

/**
 * Produce the OTel environment variables to inject into a spawned coding agent.
 *
 * GATED: when `endpoint` is unset/empty this returns `{}` — inject NOTHING and
 * behave exactly as before. When set, it returns OTEL_EXPORTER_OTLP_ENDPOINT and
 * (if any spine values are present) OTEL_RESOURCE_ATTRIBUTES with the caller's
 * pre-existing value preserved.
 *
 * RUNTIME-AGNOSTIC BY DESIGN: this helper emits only standard OTel variables
 * that every acpx engine understands. Per-runtime switches (e.g. Claude Code's
 * CLAUDE_CODE_ENABLE_TELEMETRY) belong at the launch site next to the engine
 * they apply to, alongside the existing ANTHROPIC_MODEL handling — not here.
 *
 * @param spine   the run's correlation spine
 * @param endpoint the configured OTLP endpoint (APEX_OTLP_ENDPOINT), or nullish
 * @param existingResourceAttributes any OTEL_RESOURCE_ATTRIBUTES already on the
 *   env being constructed (preserved / appended-to, never clobbered)
 */
export function otelEnv(
  spine: RunSpine,
  endpoint: string | null | undefined,
  existingResourceAttributes?: string,
): Record<string, string> {
  const normalizedEndpoint = normalizeValue(endpoint);
  if (normalizedEndpoint === null) return {};

  const out: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: normalizedEndpoint,
  };
  const spineAttrs = buildResourceAttributes(spine);
  const merged = mergeResourceAttributes(existingResourceAttributes, spineAttrs);
  if (merged) out.OTEL_RESOURCE_ATTRIBUTES = merged;
  return out;
}
