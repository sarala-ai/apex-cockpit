/**
 * Ticket lifecycle engine (spec 002) — the state machine.
 *
 * Discipline: coordinators (LLM) draft spec/plan at the edges; execution steps
 * are deterministic APEX workflows run through the ExecutionRunner. Gates BLOCK
 * on a human decision. Failures are surfaced, never swallowed into success.
 *
 * Driven by the cockpit as: ingest → step → decide(approve) → step → … until
 * `done`. `step` performs the current working stage's automated work and lands
 * on the next gate (or `failed`). `decide` applies a gate decision.
 */

import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '../errors.js';
import type { CoordinatorAgent } from './coordinator.js';
import type { ExecutionRunner } from './runner.js';
import type { WorkingStore } from './store.js';
import type { TicketSource } from './ticket-source.js';
import { isGate, type GateDecision, type Run, type Stage } from './types.js';

export interface EngineDeps {
  source: TicketSource;
  store: WorkingStore;
  runner: ExecutionRunner;
  coordinator: CoordinatorAgent;
}

type Sink = (chunk: string) => void;

export class LifecycleEngine {
  constructor(private readonly deps: EngineDeps) {}

  /** Mirror a ticket from the source into the store at `ingested`. */
  async ingest(repo: string, number: number): Promise<Result<Run>> {
    const res = await this.deps.source.get(repo, number);
    if (!res.ok) return res;
    const run: Run = {
      runId: randomUUID(),
      ticket: res.value,
      stage: 'ingested',
      tasks: [],
      gates: [],
    };
    await this.deps.store.put(run);
    return ok(run);
  }

  /** Perform the current working stage's automated work; land on a gate/terminal. */
  async step(runId: string, onData: Sink): Promise<Result<Run>> {
    const run = await this.deps.store.get(runId);
    if (!run) return err('empty', `No run ${runId}.`);

    switch (run.stage) {
      case 'ingested':
      case 'specifying': {
        run.stage = 'specifying';
        run.spec = await this.deps.coordinator.spec(run.ticket, onData);
        run.stage = 'gate:spec_review';
        break;
      }
      case 'planning': {
        if (!run.spec) return this.fail(run, 'planning', 'no approved spec');
        const { artifact, tasks } = await this.deps.coordinator.plan(run.ticket, run.spec, onData);
        run.plan = artifact;
        run.tasks = tasks;
        run.stage = 'gate:plan_review';
        break;
      }
      case 'executing': {
        for (const task of run.tasks) {
          task.status = 'running';
          await this.deps.store.put(run);
          onData(`\n▶ ${task.title} (apex run ${task.workflow})\n`);
          const r = await this.deps.runner.run(task, onData);
          task.status = r.ok ? 'passed' : 'failed';
          if (!r.ok) {
            await this.deps.store.put(run);
            return this.fail(run, task.title, r.message ?? 'step failed');
          }
        }
        // All tasks passed. PR creation through the runner/source is the next
        // wiring step; for now advance to the human PR-review gate.
        run.stage = 'gate:pr_review';
        break;
      }
      default:
        // At a gate or terminal — nothing automated to do; caller must decide().
        return ok(run);
    }
    await this.deps.store.put(run);
    return ok(run);
  }

  /** Apply a human decision at a gate. Records it and advances (or fails). */
  async decide(runId: string, decision: GateDecision): Promise<Result<Run>> {
    const run = await this.deps.store.get(runId);
    if (!run) return err('empty', `No run ${runId}.`);
    if (!isGate(run.stage)) {
      return err('tool-failed', `Run ${runId} is at ${run.stage}, not a gate.`);
    }

    run.gates.push({ stage: run.stage, decision, at: new Date().toISOString() });

    if (decision.kind === 'reject') {
      const r = this.fail(run, run.stage, `rejected: ${decision.reason}`);
      await this.deps.store.put(run);
      return r;
    }

    if (decision.kind === 'edit') {
      // Persist the human edit into the ephemeral artifact; stay at the gate.
      if (run.stage === 'gate:spec_review' && run.spec) run.spec.body = decision.body;
      if (run.stage === 'gate:plan_review' && run.plan) run.plan.body = decision.body;
      await this.deps.store.put(run);
      return ok(run);
    }

    // approve → move to the next working stage
    const next: Partial<Record<Stage, Stage>> = {
      'gate:spec_review': 'planning',
      'gate:plan_review': 'executing',
      'gate:pr_review': 'done',
    };
    run.stage = next[run.stage] ?? run.stage;
    await this.deps.store.put(run);
    return ok(run);
  }

  private fail(run: Run, step: string, message: string): Result<Run> {
    run.stage = 'failed';
    run.failure = { step, message };
    return ok(run);
  }
}
