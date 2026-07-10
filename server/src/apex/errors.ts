/**
 * Classified, non-throwing error handling for external-tool integration.
 *
 * The sidecar shells out to optional tools (apex, gh) and talks to an optional
 * service (SigNoz). None of those being present must ever crash the sidecar.
 * Every observe source returns a discriminated result so the route layer can
 * decide the HTTP shape without try/catch scattered everywhere.
 */

export type Ok<T> = { ok: true; value: T };
export type Err = {
  ok: false;
  /** Machine-readable class so the UI/route can branch. */
  kind: ErrorKind;
  /** Human-actionable message — never a raw stack. */
  message: string;
};
export type Result<T> = Ok<T> | Err;

export type ErrorKind =
  | 'tool-missing' // binary not on PATH
  | 'tool-unauth' // present but not authenticated (e.g. gh)
  | 'tool-failed' // ran but exited non-zero
  | 'unreachable' // network target refused / timed out (SigNoz)
  | 'empty' // reachable but no data yet
  | 'parse-failed'; // ran but output was not the expected JSON

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = (kind: ErrorKind, message: string): Err => ({
  ok: false,
  kind,
  message,
});

/** Node's spawn error code for a missing binary. */
export function isMissingBinary(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: string }).code === 'ENOENT'
  );
}
