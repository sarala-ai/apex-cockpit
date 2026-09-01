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

/** Structured result parsed from `apex … --output json`'s stdout. */
export interface WorkflowRunResult {
  /** Inner APEX result status: 'success' | 'error' | … */
  status: string;
  instanceName?: string;
  workflowName?: string;
  executionMode?: string;
  stepsCompleted: string[];
  stepsFailed: string[];
  resourcesCreated: unknown[];
  lastError?: string | null;
}

export interface StepResult {
  ok: boolean;
  /** Non-zero exit, spawn error, or apex-reported failure. Surfaced, never swallowed. */
  message?: string;
  /** Parsed structured result when apex emitted a JSON result on stdout. */
  result?: WorkflowRunResult;
}

export interface ExecutionRunner {
  readonly kind: 'local' | 'remote';
  /**
   * Execute one task as an APEX workflow. `onData` receives live progress
   * (apex writes its setup/run banner to stderr in `--output json` mode) for
   * streaming to the cockpit; the structured result is parsed from stdout.
   *
   * Provider selection: apex loads resource-servers by provider. Set it
   * explicitly via `task.provider` (→ APEX_CLOUD_PROVIDER) for a cwd-independent
   * result; otherwise apex walks UP from `cwd` for a project `.apex/settings.yaml`
   * (else ~/.apex/settings.yaml, else 'aws'). The wrong provider fails the run
   * with "Server '<x>' not found" (e.g. a gcp workflow resolved under aws).
   */
  run(task: Task, onData: (chunk: string) => void, cwd?: string): Promise<StepResult>;
}

/**
 * Parse apex's `--output json` result envelope. In JSON mode apex emits exactly
 * one JSON object on stdout: `{ status, result: { status, instance_name,
 * steps_completed, steps_failed, resources_created, execution_mode, last_error },
 * message }` (diagnostics go to stderr). Returns null if stdout isn't that shape.
 */
function parseApexResult(stdout: string): { envelopeStatus: string; message?: string; result: WorkflowRunResult } | null {
  const text = stdout.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const env = raw as Record<string, unknown>;
  const inner = (env.result ?? {}) as Record<string, unknown>;
  const asStrArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    envelopeStatus: typeof env.status === 'string' ? env.status : 'unknown',
    message: typeof env.message === 'string' ? env.message : undefined,
    result: {
      status: typeof inner.status === 'string' ? inner.status : 'unknown',
      instanceName: typeof inner.instance_name === 'string' ? inner.instance_name : undefined,
      workflowName: typeof inner.workflow_name === 'string' ? inner.workflow_name : undefined,
      executionMode: typeof inner.execution_mode === 'string' ? inner.execution_mode : undefined,
      stepsCompleted: asStrArr(inner.steps_completed),
      stepsFailed: asStrArr(inner.steps_failed),
      resourcesCreated: Array.isArray(inner.resources_created) ? inner.resources_created : [],
      lastError: typeof inner.last_error === 'string' ? inner.last_error : null,
    },
  };
}

export class LocalRunner implements ExecutionRunner {
  readonly kind = 'local' as const;

  constructor(private readonly apexBin = 'apex') {}

  run(task: Task, onData: (chunk: string) => void, cwd?: string): Promise<StepResult> {
    // Deterministic core: dispatch the workflow via apex's workflow-engine `run`
    // tool. `--output json` → clean JSON result on stdout, progress on stderr.
    // execution_mode defaults to 'plan' (dry-run) unless the task opts into apply.
    const mode = task.executionMode ?? 'plan';
    const args = [
      '--output', 'json',
      'run', 'workflow', 'run',
      '--workflow', task.workflow,
      '--execution-mode', mode,
    ];
    if (Object.keys(task.params).length > 0) {
      args.push('--params', JSON.stringify(task.params));
    }
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
        // Set the provider explicitly (APEX_CLOUD_PROVIDER) when known so apex
        // loads the right resource-servers independent of cwd; still pass cwd so
        // apex can fall back to the workspace's `.apex/settings.yaml`.
        const env = task.provider
          ? { ...process.env, APEX_CLOUD_PROVIDER: task.provider }
          : process.env;
        child = spawn(this.apexBin, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
          ...(cwd ? { cwd } : {}),
        });
      } catch (e) {
        return done({ ok: false, message: `could not spawn ${this.apexBin}: ${String(e)}` });
      }
      // stdout = machine-readable JSON result (accumulate, parse on close).
      // stderr = human progress (stream live to the cockpit).
      let stdout = '';
      let stderrTail = '';
      child.stdout.on('data', (b: Buffer) => {
        stdout += b.toString();
      });
      child.stderr.on('data', (b: Buffer) => {
        const s = b.toString();
        stderrTail = (stderrTail + s).slice(-2000);
        onData(s);
      });
      // ENOENT etc. — surface it; do NOT resolve as success.
      child.on('error', (e) => done({ ok: false, message: `${this.apexBin} error: ${e.message}` }));
      child.on('close', (code) => {
        const parsed = parseApexResult(stdout);
        if (!parsed) {
          // No JSON result on stdout — surface the failure with the exit code and
          // any stderr tail; never silently pass.
          return done({
            ok: false,
            message:
              code === 0
                ? `${task.workflow}: apex produced no JSON result on stdout${stderrTail ? ` — ${stderrTail.trim().slice(-300)}` : ''}`
                : `${task.workflow} exited ${code ?? 'null'}${stderrTail ? ` — ${stderrTail.trim().slice(-300)}` : ''}`,
          });
        }
        const ok =
          code === 0 &&
          parsed.envelopeStatus === 'success' &&
          parsed.result.status === 'success' &&
          !parsed.result.lastError;
        return done({
          ok,
          result: parsed.result,
          message: ok
            ? undefined
            : parsed.result.lastError ??
              parsed.message ??
              `${task.workflow} failed (${parsed.result.status})`,
        });
      });
    });
  }
}
