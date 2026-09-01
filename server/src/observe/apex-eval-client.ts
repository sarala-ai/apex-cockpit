/**
 * ApexEvalTraceClient — enriches a run's Observe detail with the OTel-backed trace
 * (spans, tool calls) and eval verdicts held by the apex-eval service.
 *
 * apex-eval owns the trace/eval read API over HTTP; this is the thin client the
 * cockpit uses to pull that data in, validated against the SAME zod schemas the UI
 * consumes (@paperclipai/shared), so drift between the two services is caught at
 * the boundary rather than surfacing as a UI bug.
 *
 * Failure-isolated like every other observe source: apex-eval being down, slow, or
 * returning a bad shape must never break Observe — the run still shows (from the
 * owning store), just without its trace. So getTrace NEVER throws; any failure
 * degrades to empty arrays plus a logged warning with enough context to debug.
 */
import { z } from "zod";
import { TraceSpanSchema, ToolCallSchema, EvalRecordSchema } from "@paperclipai/shared";
import type { TraceSpan, ToolCall, EvalRecord } from "@paperclipai/shared";

export interface TraceEnricher {
  getTrace(runId: string): Promise<{ spans: TraceSpan[]; toolCalls: ToolCall[]; evals: EvalRecord[] }>;
}

const EMPTY = { spans: [] as TraceSpan[], toolCalls: [] as ToolCall[], evals: [] as EvalRecord[] };

const TraceResponseSchema = z.object({
  spans: z.array(TraceSpanSchema),
  toolCalls: z.array(ToolCallSchema),
});

/**
 * AgentRun-ish rows as returned by apex-eval's `GET /runs?companyId=&agentName=`
 * — the distinct app runs (from spans) for a product agent, most-recent first.
 * This is a subset of AgentRunSchema (@paperclipai/shared): the fields the runs
 * listing carries. Validated here so a shape drift is caught at the boundary.
 */
export const EvalAgentRunSchema = z.object({
  runId: z.string(),
  agentName: z.string().nullable(),
  status: z.string().nullable(),
  startedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
});
export type EvalAgentRun = z.infer<typeof EvalAgentRunSchema>;

/** Reads a product agent's app runs (application traces) from apex-eval. Used to
 *  correlate a Cloud Run service with the runs its agent actually emitted. */
export interface AgentRunReader {
  getRuns(companyId: string | undefined, agentName: string, limit?: number): Promise<EvalAgentRun[]>;
}

export class ApexEvalTraceClient implements TraceEnricher, AgentRunReader {
  constructor(private readonly baseUrl: string = process.env.APEX_EVAL_URL ?? "http://localhost:8000") {}

  async getRuns(
    companyId: string | undefined,
    agentName: string,
    limit = 50,
  ): Promise<EvalAgentRun[]> {
    try {
      const qs = new URLSearchParams({ agentName, limit: String(limit) });
      if (companyId) qs.set("companyId", companyId);
      const res = await fetch(`${this.baseUrl}/runs?${qs.toString()}`);
      if (!res.ok) {
        console.warn(
          `[observe] apex-eval runs fetch failed for agent ${agentName}: ${res.status}`,
        );
        return [];
      }
      return z.array(EvalAgentRunSchema).parse(await res.json());
    } catch (e) {
      console.warn(`[observe] apex-eval runs fetch failed for agent ${agentName}:`, e);
      return [];
    }
  }

  async getTrace(runId: string): Promise<{ spans: TraceSpan[]; toolCalls: ToolCall[]; evals: EvalRecord[] }> {
    try {
      const [traceRes, evalsRes] = await Promise.all([
        fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/trace`),
        fetch(`${this.baseUrl}/evals?runId=${encodeURIComponent(runId)}`),
      ]);

      if (!traceRes.ok || !evalsRes.ok) {
        console.warn(
          `[observe] apex-eval trace fetch failed for run ${runId}: trace=${traceRes.status} evals=${evalsRes.status}`,
        );
        return EMPTY;
      }

      const [traceJson, evalsJson] = await Promise.all([traceRes.json(), evalsRes.json()]);
      const trace = TraceResponseSchema.parse(traceJson);
      const evals = z.array(EvalRecordSchema).parse(evalsJson);

      return { spans: trace.spans, toolCalls: trace.toolCalls, evals };
    } catch (e) {
      console.warn(`[observe] apex-eval trace enrichment failed for run ${runId}:`, e);
      return EMPTY;
    }
  }
}
