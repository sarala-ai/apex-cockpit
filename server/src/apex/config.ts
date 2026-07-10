/** Sidecar configuration. Local-first, single-user — bind loopback only. */
export const config = {
  host: process.env.APEX_TOWER_SIDECAR_HOST ?? '127.0.0.1',
  port: Number(process.env.APEX_TOWER_SIDECAR_PORT ?? 8787),
  /** SigNoz query-service base URL (its REST API). */
  signozUrl: process.env.SIGNOZ_URL ?? 'http://localhost:8080',
  /** Optional SigNoz API key (SIGNOZ-API-KEY header) for self-hosted auth. */
  signozApiKey: process.env.SIGNOZ_API_KEY ?? '',
  /** Default shell for the PTY when the client does not specify a command. */
  defaultShell: process.env.SHELL ?? '/bin/bash',
} as const;
