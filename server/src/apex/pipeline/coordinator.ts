/**
 * CoordinatorAgent seam (spec 002). One-shot agents that draft the spec and the
 * plan. Real impl wraps the Claude Agent SDK in *streaming input* mode so the
 * cockpit can watch tokens/thinking/tool-calls live and interrupt.
 *
 * This milestone lands the interface + a deterministic stub so the state machine
 * is exercisable end-to-end without the SDK wired. Replacing the stub with the
 * Agent SDK bridge is the next focused step and touches nothing else.
 */

import type { Artifact, Task, Ticket } from './types.js';

export interface CoordinatorAgent {
  /** Draft a spec artifact from the ticket. */
  spec(ticket: Ticket, onData: (chunk: string) => void): Promise<Artifact>;
  /** Draft a plan artifact + ordered tasks from an approved spec. */
  plan(
    ticket: Ticket,
    spec: Artifact,
    onData: (chunk: string) => void,
  ): Promise<{ artifact: Artifact; tasks: Task[] }>;
}

/**
 * Deterministic placeholder — emits a legible artifact so gates/execution can be
 * driven in dev. NOT an LLM; clearly marked so it is never mistaken for real output.
 */
export class StubCoordinator implements CoordinatorAgent {
  async spec(ticket: Ticket, onData: (chunk: string) => void): Promise<Artifact> {
    onData(`[stub] drafting spec for ${ticket.id}…\n`);
    const body = `# Spec (stub) — ${ticket.title}\n\nFrom ${ticket.url}\n\n${ticket.body}\n`;
    return { kind: 'spec', body };
  }

  async plan(
    ticket: Ticket,
    _spec: Artifact,
    onData: (chunk: string) => void,
  ): Promise<{ artifact: Artifact; tasks: Task[] }> {
    onData(`[stub] drafting plan for ${ticket.id}…\n`);
    const tasks: Task[] = [
      { id: 't1', title: 'build', workflow: 'build', params: {}, status: 'pending' },
      { id: 't2', title: 'test', workflow: 'test', params: {}, status: 'pending' },
    ];
    const body = `# Plan (stub) — ${ticket.title}\n\n1. build\n2. test\n`;
    return { artifact: { kind: 'plan', body }, tasks };
  }
}
