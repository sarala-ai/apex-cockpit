/**
 * Observe tool surface — the READ-ONLY MCP tool contract for the APEX observe
 * capability. One capability, two consumers: the control-tower UI (thin HTTP
 * passthrough) and agents (which reach it via the gateway). Registered in the
 * gateway so agents call it uniformly.
 *
 * Discipline: these tools are strictly READ-ONLY (sensing). An agent uses them to
 * diagnose, then files a fix/analysis ticket via a SEPARATE write tool
 * (issue.create) — sensing and acting are different trust scopes and stay split,
 * so the observe → diagnose → file-ticket loop is explicit and auditable.
 *
 * Backend-agnostic: an implementation binds these to a store adapter (Cloud Trace
 * / Cloud Monitoring first, SigNoz optional). The tool surface never changes when
 * the backend does.
 */
import { z } from "zod";
import type {
  AgentRun,
  RunDetail,
  EvalRecord,
  HealthSummary,
  FleetEntry,
  Regression,
} from "./contract.js";

const scopeInput = {
  companyId: z.string().optional(),
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  repo: z.string().optional(),
  env: z.enum(["dev", "staging", "prod", "local"]).optional(),
};

export const observeInputs = {
  fleet: z.object({ ...scopeInput }),
  runs: z.object({
    ...scopeInput,
    status: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(25),
  }),
  runDetail: z.object({ runId: z.string() }),
  evals: z.object({
    ...scopeInput,
    verdict: z.enum(["pass", "warn", "fail"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  health: z.object({
    ...scopeInput,
    windowHours: z.coerce.number().int().min(1).max(720).default(24),
  }),
  regressions: z.object({
    ...scopeInput,
    windowHours: z.coerce.number().int().min(1).max(720).default(24),
  }),
} as const;

export interface ObserveToolDef<I extends z.ZodTypeAny, O> {
  name: string;
  title: string;
  description: string;
  readOnly: true;
  input: I;
  /** Phantom marker carrying the output type for consumers; never set at runtime. */
  readonly _output?: O;
}

export const OBSERVE_TOOLS = {
  observe_fleet: {
    name: "observe_fleet",
    title: "Fleet inventory + health",
    description:
      "List a company's agents / MCP servers / workflows with health, last run, and 24h success rate. Read-only.",
    readOnly: true,
    input: observeInputs.fleet,
  } as ObserveToolDef<typeof observeInputs.fleet, FleetEntry[]>,

  observe_runs: {
    name: "observe_runs",
    title: "Recent agent runs",
    description:
      "Recent agent/workflow runs in scope, with status, duration, tokens, and cost. Read-only.",
    readOnly: true,
    input: observeInputs.runs,
  } as ObserveToolDef<typeof observeInputs.runs, AgentRun[]>,

  observe_run_detail: {
    name: "observe_run_detail",
    title: "Run detail (trace)",
    description:
      "Full trace for one run — spans, tool calls, LLM calls, evals — to debug why it did what it did. Read-only.",
    readOnly: true,
    input: observeInputs.runDetail,
  } as ObserveToolDef<typeof observeInputs.runDetail, RunDetail>,

  observe_evals: {
    name: "observe_evals",
    title: "Eval verdicts",
    description:
      "Recent evaluation verdicts (pass/warn/fail + score + reason) in scope. Read-only.",
    readOnly: true,
    input: observeInputs.evals,
  } as ObserveToolDef<typeof observeInputs.evals, EvalRecord[]>,

  observe_health: {
    name: "observe_health",
    title: "Health summary",
    description:
      "Aggregate health for a scope over a window: success rate, avg duration, cost, eval pass rate. Read-only.",
    readOnly: true,
    input: observeInputs.health,
  } as ObserveToolDef<typeof observeInputs.health, HealthSummary>,

  observe_regressions: {
    name: "observe_regressions",
    title: "Regressions",
    description:
      "What got worse vs the prior window — success rate, eval score, latency, cost. Feeds the improvement loop. Read-only.",
    readOnly: true,
    input: observeInputs.regressions,
  } as ObserveToolDef<typeof observeInputs.regressions, Regression[]>,
} as const;

export type ObserveToolName = keyof typeof OBSERVE_TOOLS;

/** The store adapter every backend (Cloud Trace/Monitoring, SigNoz, …) implements. */
export interface ObserveStore {
  fleet(input: z.infer<typeof observeInputs.fleet>): Promise<FleetEntry[]>;
  runs(input: z.infer<typeof observeInputs.runs>): Promise<AgentRun[]>;
  runDetail(input: z.infer<typeof observeInputs.runDetail>): Promise<RunDetail | null>;
  evals(input: z.infer<typeof observeInputs.evals>): Promise<EvalRecord[]>;
  health(input: z.infer<typeof observeInputs.health>): Promise<HealthSummary>;
  regressions(input: z.infer<typeof observeInputs.regressions>): Promise<Regression[]>;
}
