import { execFile } from 'node:child_process';
import { isMissingBinary } from './errors.js';

export type ExecResult =
  | { status: 'ok'; stdout: string }
  | { status: 'missing' }
  | { status: 'failed'; code: number | null; stderr: string };

/**
 * Run a binary with args, capturing stdout. Never throws — a missing binary
 * or non-zero exit is returned as a classified result. `execFile` (no shell)
 * avoids shell-injection from repo names etc.
 */
export function run(
  bin: string,
  args: string[],
  timeoutMs = 8000,
  cwd?: string,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, cwd },
      (error, stdout, stderr) => {
        if (error) {
          if (isMissingBinary(error)) return resolve({ status: 'missing' });
          const code =
            typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : null;
          return resolve({ status: 'failed', code, stderr: stderr || String(error) });
        }
        resolve({ status: 'ok', stdout });
      },
    );
  });
}
