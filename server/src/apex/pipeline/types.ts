/**
 * Ticket lifecycle engine — core types (spec 002).
 *
 * The pipeline is an explicit state machine. Gate states BLOCK until a human
 * decision arrives from the cockpit; every gate decision is recorded to the
 * audit ledger. Coordinator agents (spec, plan) are one-shot. Execution steps
 * are deterministic APEX workflows dispatched by a thin orchestrator.
 */

/** Named pipeline states. `gate:*` states block on a human decision. */
export type Stage =
  | 'ingested'
  | 'specifying'
  | 'gate:spec_review'
  | 'planning'
  | 'gate:plan_review'
  | 'executing'
  | 'gate:pr_review'
  | 'done'
  | 'failed';

export const GATE_STAGES = [
  'gate:spec_review',
  'gate:plan_review',
  'gate:pr_review',
] as const satisfies readonly Stage[];

export function isGate(stage: Stage): boolean {
  return (GATE_STAGES as readonly Stage[]).includes(stage);
}

/** A human decision at a gate. `edit` carries the revised artifact body. */
export type GateDecision =
  | { kind: 'approve' }
  | { kind: 'edit'; body: string }
  | { kind: 'reject'; reason: string };

export interface GateRecord {
  stage: Stage;
  decision: GateDecision;
  /** ISO timestamp, stamped by the caller (engine has no wall-clock of its own). */
  at: string;
}

/** A ticket mirrored from the source of truth (GitHub Issues) into the store. */
export interface Ticket {
  /** Stable source id, e.g. "owner/repo#123". */
  id: string;
  source: 'github' | 'repo' | 'linear';
  repo: string; // owner/name
  number: number;
  title: string;
  body: string;
  url: string;
  status: string;
}

/** Ephemeral work-order artifact (spec or plan). Disposable after merge. */
export interface Artifact {
  kind: 'spec' | 'plan';
  body: string;
  /** Tokens/cost the coordinator spent producing it, if known. */
  tokens?: number;
  costUsd?: number;
}

/** One executable unit of the approved plan. Executed as an APEX workflow. */
export interface Task {
  id: string;
  title: string;
  /** APEX workflow name this task dispatches (deterministic core). */
  workflow: string;
  /** Free-form params handed to the workflow. */
  params: Record<string, string>;
  status: 'pending' | 'running' | 'passed' | 'failed';
}

/** The full pipeline record for one ticket. This is the WorkingStore row. */
export interface Run {
  runId: string;
  ticket: Ticket;
  stage: Stage;
  spec?: Artifact;
  plan?: Artifact;
  tasks: Task[];
  gates: GateRecord[];
  prUrl?: string;
  /** Set when stage === 'failed': the step that failed + why. Never silent. */
  failure?: { step: string; message: string };
}
