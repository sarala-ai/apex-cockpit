/**
 * EvalIngestClient — feeds resource-health checks and gateway-audit outcomes
 * into apex-eval's EXISTING pipeline, rather than building new eval
 * infrastructure. Concretely: emit one OTLP/JSON span per check (via apex-
 * eval's `POST /v1/traces`, using the exact correlation-spine + span-kind +
 * attribute keys apex-eval's receiver.py already decodes — see
 * observe/contract.ts), then trigger `POST /runs/{runId}/eval`, which runs
 * apex-eval's built-in trajectory evaluators (run_eval.py) over it:
 *   - a resource-health check emits one `agent.run` span with `apex.run.status`
 *     mapped to succeeded/failed → scored by RunCompletedEvaluator (verdict
 *     pass/fail on terminal status) — an existing evaluator, zero new code.
 *   - a gateway-audit entry emits one `tool.call` span with `apex.tool.success`
 *     → scored by ToolSuccessRateEvaluator — same reuse.
 * Results land in apex-eval's `eval_results` table and are already surfaced by
 * the cockpit's existing GET /observe/evals (Observe's Evals card) — no new
 * eval UI needed.
 *
 * Deliberately minimal (per the build plan): this proves the hookup works,
 * it does not introduce a new evaluator taxonomy for resources/gateway calls.
 *
 * Failure-isolated + fire-and-forget: emission must never slow down or break
 * the route that triggered it (a resource-health lookup, an audit-trail
 * fetch) — every failure is caught and logged, never thrown.
 */
import { randomBytes } from "node:crypto";

const EVAL_URL = (): string => (process.env.APEX_EVAL_URL ?? "http://localhost:8000").replace(/\/$/, "");

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function nowNanos(): string {
  return String(BigInt(Date.now()) * 1_000_000n);
}

interface SpineAttrs {
  companyId?: string;
  projectId?: string;
  agentKind?: "coding" | "product" | "workflow";
  agentName?: string;
  repo?: string;
  /** Canonical join key across panes (GCP Inventory / Gateway audit / eval
   *  results) — declared in contract.ts's Spine but not yet decoded into its
   *  own column on the apex-eval side (receiver.py's SPINE_ATTR / SpineMixin
   *  are missing it). Still worth stamping now: apex-eval's Span.attributes
   *  JSONB captures the full raw attribute set regardless, so this becomes
   *  queryable the moment that column lands, with nothing lost meanwhile.
   *  For GCP resources, use Cloud Asset Inventory's fully-qualified `name`
   *  (e.g. "//run.googleapis.com/projects/P/locations/R/services/S") — already
   *  globally unique, no new id scheme needed. */
  resourceId?: string;
  /** WHO caused this — the credential that performed the effect (gcloud/git/gh
   *  identity locally, session identity under enterprise auth), never a typed
   *  name. The spine carried company/project/agent/run/repo/resource but no
   *  actor, so a run could not answer "who set this off"; audit rows, resource
   *  labels and cost attribution all inherit it via run id. */
  actor?: string;
  /** For agent runs: the human the agent acted for. An agent principal alone
   *  answers "what ran", not "on whose authority". */
  actorOnBehalfOf?: string;
}

function spineKeyValues(spine: SpineAttrs): Array<{ key: string; value: { stringValue: string } }> {
  const kv: Array<{ key: string; value: { stringValue: string } }> = [];
  if (spine.companyId) kv.push({ key: "apex.company.id", value: { stringValue: spine.companyId } });
  if (spine.projectId) kv.push({ key: "apex.project.id", value: { stringValue: spine.projectId } });
  if (spine.agentKind) kv.push({ key: "apex.agent.kind", value: { stringValue: spine.agentKind } });
  if (spine.agentName) kv.push({ key: "apex.agent.name", value: { stringValue: spine.agentName } });
  if (spine.repo) kv.push({ key: "apex.repo", value: { stringValue: spine.repo } });
  if (spine.resourceId) kv.push({ key: "apex.resource.id", value: { stringValue: spine.resourceId } });
  if (spine.actor) kv.push({ key: "apex.actor", value: { stringValue: spine.actor } });
  if (spine.actorOnBehalfOf)
    kv.push({ key: "apex.actor.on_behalf_of", value: { stringValue: spine.actorOnBehalfOf } });
  return kv;
}

async function postJson(url: string, body: unknown, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function emitSpan(params: {
  runId: string;
  name: string;
  spanKindAttr: "agent.run" | "tool.call";
  extraAttrs: Array<{ key: string; value: { stringValue: string } | { boolValue: boolean } }>;
  spine: SpineAttrs;
}): Promise<boolean> {
  const traceId = hex(16);
  const spanId = hex(8);
  const ts = nowNanos();
  const body = {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                name: params.name,
                startTimeUnixNano: ts,
                endTimeUnixNano: ts,
                attributes: [
                  { key: "apex.span.kind", value: { stringValue: params.spanKindAttr } },
                  { key: "apex.run.id", value: { stringValue: params.runId } },
                  ...spineKeyValues(params.spine),
                  ...params.extraAttrs,
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  return postJson(`${EVAL_URL()}/v1/traces`, body);
}

async function triggerEval(runId: string): Promise<void> {
  await postJson(`${EVAL_URL()}/runs/${encodeURIComponent(runId)}/eval`, {});
}

export class EvalIngestClient {
  /** GCP resource-health outcome → RunCompletedEvaluator (verdict pass/fail on
   *  terminal status). `healthy` maps to "succeeded", anything else to "failed". */
  async evaluateResourceHealth(params: {
    projectId: string;
    resourceType: string;
    resourceName: string;
    healthy: boolean;
    companyId?: string;
    /** Cloud Asset Inventory's fully-qualified resource name, when known from
     *  an inventory listing — the cross-pane join key (see class docstring). */
    resourceId?: string;
  }): Promise<void> {
    const runId = `gcp-resource:${params.projectId}:${params.resourceType}:${params.resourceName}:${Date.now()}`;
    try {
      const ok = await emitSpan({
        runId,
        name: `gcp-resource-health:${params.resourceType}`,
        spanKindAttr: "agent.run",
        spine: {
          companyId: params.companyId,
          projectId: params.projectId,
          agentKind: "workflow",
          resourceId: params.resourceId,
        },
        extraAttrs: [
          {
            key: "apex.run.status",
            value: { stringValue: params.healthy ? "succeeded" : "failed" },
          },
        ],
      });
      if (ok) await triggerEval(runId);
    } catch (e) {
      console.warn(`[observe] eval ingest failed for resource health (${runId}):`, e);
    }
  }

  /** Gateway audit entry → ToolSuccessRateEvaluator (fraction of tool_calls
   *  with success=True — here always exactly one). */
  async evaluateGatewayAudit(params: {
    auditEntryId: string;
    action: string;
    success: boolean;
    companyId?: string;
    /** The audited resource's id, when the gateway reported one — same
     *  cross-pane join key as evaluateResourceHealth's resourceId. */
    resourceId?: string;
  }): Promise<void> {
    const runId = `gateway-audit:${params.auditEntryId}`;
    try {
      const ok = await emitSpan({
        runId,
        name: `gateway-audit:${params.action}`,
        spanKindAttr: "tool.call",
        spine: { companyId: params.companyId, agentKind: "workflow", resourceId: params.resourceId },
        extraAttrs: [
          { key: "apex.tool.name", value: { stringValue: params.action } },
          { key: "apex.tool.server", value: { stringValue: "apex-gateway" } },
          { key: "apex.tool.via_gateway", value: { boolValue: true } },
          { key: "apex.tool.success", value: { boolValue: params.success } },
        ],
      });
      if (ok) await triggerEval(runId);
    } catch (e) {
      console.warn(`[observe] eval ingest failed for gateway audit (${runId}):`, e);
    }
  }
}
