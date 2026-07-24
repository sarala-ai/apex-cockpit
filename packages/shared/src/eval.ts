/**
 * Eval faculty contract — SHARED between the UI (browses evaluators, shows results)
 * and the backend (invokes evaluators). One schema-first source so the "pull evals
 * from supported libraries via UI or via the backend" surface can't drift.
 *
 * Split (the lesson from config-as-code eval attempts): evaluators are CODE (wrapped
 * library scorers + our own), described by an `EvaluatorDescriptor`; the *wiring*
 * (which evaluators apply where, thresholds, datasets) is tracked registry DATA on
 * the org→company→project→agent cascade — NOT a sprawling config file. An
 * `EvalResult` carries provenance (evaluatorId + version + scope) so every score is
 * traceable, and maps onto the observe `EvalRecord` (so eval flows into Observe).
 */
import { z } from "zod";
import { EvalVerdictSchema } from "./observe.js";

/** Provenance of an evaluator: ours (builtin), an adopter's product-scoped one, or agent-scoped. */
export const EvaluatorScopeSchema = z.enum(["builtin", "product", "agent"]);
export type EvaluatorScope = z.infer<typeof EvaluatorScopeSchema>;

export const EvaluatorKindSchema = z.enum(["deterministic", "llm_judge", "rag", "custom"]);
export type EvaluatorKind = z.infer<typeof EvaluatorKindSchema>;

/** Which EvalInput fields an evaluator consumes — drives the UI form + validation. */
export const EvaluatorInputFieldSchema = z.enum(["output", "input", "expected", "context", "criteria"]);
export type EvaluatorInputField = z.infer<typeof EvaluatorInputFieldSchema>;

/** What the UI browses and what identifies an evaluator across the system. */
export const EvaluatorDescriptorSchema = z.object({
  id: z.string(), // "<library>:<name>", e.g. "autoevals:Factuality"
  library: z.string(), // "builtin" | "autoevals" | "ragas" | "promptfoo" | ...
  name: z.string(),
  description: z.string(),
  kind: EvaluatorKindSchema,
  inputs: z.array(EvaluatorInputFieldSchema),
});
export type EvaluatorDescriptor = z.infer<typeof EvaluatorDescriptorSchema>;

/** What an evaluator scores. Reference-based evaluators use `expected`; RAG ones use
 *  `context`; LLM-judges use `criteria`. */
export const EvalInputSchema = z.object({
  output: z.string(),
  input: z.string().optional(),
  expected: z.string().optional(),
  context: z.array(z.string()).optional(),
  criteria: z.string().optional(),
});
export type EvalInput = z.infer<typeof EvalInputSchema>;

/** Normalized result — maps onto the observe EvalRecord (verdict/score/reason/scope). */
export const EvalResultSchema = z.object({
  evaluatorId: z.string(),
  library: z.string(),
  name: z.string(),
  version: z.string(),
  scope: EvaluatorScopeSchema,
  verdict: EvalVerdictSchema.nullable(),
  score: z.number().nullable(), // normalized 0..1
  reason: z.string().nullable(),
  occurredAt: z.string().nullable().optional(),
});
export type EvalResult = z.infer<typeof EvalResultSchema>;
