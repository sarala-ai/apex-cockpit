/**
 * In-memory record of the most recent cockpit-mcp gateway self-registration
 * attempt (boot, a sweep tick, or the manual `POST /setup/mcp/register`).
 * Deliberately not persisted: it describes THIS process's current run, not a
 * durable fact — a restart re-attempts registration anyway, at which point
 * any stale row would just be wrong. `apex-setup-state.ts` reads this to show
 * the wizard what last happened without polling the gateway itself.
 */
import type { CockpitMcpRegistrationOutcome } from "./router.js";

export interface CockpitMcpLastAttempt {
  at: string;
  outcome: CockpitMcpRegistrationOutcome;
}

let lastAttempt: CockpitMcpLastAttempt | null = null;

export function recordCockpitMcpRegistrationAttempt(
  result: { outcome: CockpitMcpRegistrationOutcome },
  now: () => Date = () => new Date(),
): CockpitMcpLastAttempt {
  lastAttempt = { at: now().toISOString(), outcome: result.outcome };
  return lastAttempt;
}

export function getLastCockpitMcpRegistrationAttempt(): CockpitMcpLastAttempt | null {
  return lastAttempt;
}

/** Test-only reset — the module-level singleton otherwise leaks state across tests. */
export function resetCockpitMcpRegistrationAttemptForTests(): void {
  lastAttempt = null;
}
