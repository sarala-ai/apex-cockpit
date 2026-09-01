import { execFile } from 'node:child_process';
import { isMissingBinary } from './errors.js';

export type ExecResult =
  | { status: 'ok'; stdout: string }
  | { status: 'missing' }
  // stdout is kept on failure too: the apex CLI writes its structured error
  // envelope (classified error_type + actionable message) to stdout and THEN
  // exits non-zero — discarding stdout here would bury that classification.
  | { status: 'failed'; code: number | null; stderr: string; stdout: string };

/**
 * Run a binary with args, capturing stdout. Never throws — a missing binary
 * or non-zero exit is returned as a classified result. `execFile` (no shell)
 * avoids shell-injection from repo names etc. `env`, when passed, is merged
 * OVER `process.env` (not a replacement) — callers use this to widen PATH
 * (e.g. to pick up a `~/.local/bin`-installed CLI) without losing the rest
 * of the process environment the child would otherwise need.
 */
export function run(
  bin: string,
  args: string[],
  timeoutMs = 8000,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        cwd,
        env: env ? { ...process.env, ...env } : undefined,
      },
      (error, stdout, stderr) => {
        if (error) {
          if (isMissingBinary(error)) return resolve({ status: 'missing' });
          const code =
            typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : null;
          return resolve({ status: 'failed', code, stderr: stderr || String(error), stdout });
        }
        resolve({ status: 'ok', stdout });
      },
    );
  });
}
