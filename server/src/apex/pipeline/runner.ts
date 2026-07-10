/**
 * ExecutionRunner seam (spec 002).
 *
 * The control plane is always local; only *execution* may relocate. `LocalRunner`
 * runs a deterministic APEX workflow as a subprocess on the desktop and streams
 * its output. `RemoteRunner` (a provisioned GCP instance/container) is a later
 * drop-in behind this same interface — local vs remote is a config flip.
 */

import { spawn } from 'node:child_process';
import type { Task } from './types.js';

export interface StepResult {
  ok: boolean;
  /** Non-zero exit or spawn error detail when !ok. Surfaced, never swallowed. */
  message?: string;
}

export interface ExecutionRunner {
  readonly kind: 'local' | 'remote';
  /**
   * Execute one task as an APEX workflow. `onData` receives interleaved
   * stdout/stderr chunks for live streaming to the cockpit.
   */
  run(task: Task, onData: (chunk: string) => void): Promise<StepResult>;
}

export class LocalRunner implements ExecutionRunner {
  readonly kind = 'local' as const;

  constructor(private readonly apexBin = 'apex') {}

  run(task: Task, onData: (chunk: string) => void): Promise<StepResult> {
    // Deterministic core: dispatch the named APEX workflow. The orchestrator
    // (thin decider) chose the workflow + params; APEX owns the execution.
    const args = [
      'run', task.workflow,
      ...Object.entries(task.params).flatMap(([k, v]) => ['--param', `${k}=${v}`]),
    ];
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: StepResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      let child;
      try {
        child = spawn(this.apexBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return done({ ok: false, message: `could not spawn ${this.apexBin}: ${String(e)}` });
      }
      child.stdout.on('data', (b: Buffer) => onData(b.toString()));
      child.stderr.on('data', (b: Buffer) => onData(b.toString()));
      // ENOENT etc. — surface it; do NOT resolve as success.
      child.on('error', (e) => done({ ok: false, message: `${this.apexBin} error: ${e.message}` }));
      child.on('close', (code) =>
        done(
          code === 0
            ? { ok: true }
            : { ok: false, message: `${task.workflow} exited ${code ?? 'null'}` },
        ),
      );
    });
  }
}
