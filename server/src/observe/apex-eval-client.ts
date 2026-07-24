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

export class ApexEvalTraceClient implements TraceEnricher {
  constructor(private readonly baseUrl: string = process.env.APEX_EVAL_URL ?? "http://localhost:4000") {}

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
