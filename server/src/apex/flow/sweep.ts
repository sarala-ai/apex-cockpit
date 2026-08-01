/**
 * Periodic flow-coordinator sweep — the recovery half of advancement.
 *
 * Advancement is event-driven where events exist (start API, gate decision
 * hook); this sweep resumes `running` flows whose in-process advancement
 * loop died (server restart, crash) by re-executing the current node.
 * At-least-once semantics are documented on `flowCoordinator.sweep`.
 *
 * Interval: APEX_FLOW_TICK_MINUTES (default 5; 0 disables). A flow is only
 * considered stale after a full tick without a flowAdvancedAt stamp, so an
 * actively-advancing loop is never double-driven.
 */
import type { Db } from "@paperclipai/db";
import { startPeriodicJob } from "../../lib/periodic-job.js";
import { logger } from "../../middleware/logger.js";
import { flowCoordinator, type FlowCoordinator } from "./coordinator.js";

export const FLOW_TICK_ENV_VAR = "APEX_FLOW_TICK_MINUTES";
const DEFAULT_TICK_MINUTES = 5;

export function flowTickIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FLOW_TICK_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_TICK_MINUTES * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_TICK_MINUTES * 60_000;
  return minutes * 60_000;
}

export function startFlowCoordinatorSweep(
  db: Db,
  options: { coordinator?: FlowCoordinator; intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? flowTickIntervalMs();
  const coordinator = options.coordinator ?? flowCoordinator(db);
  return startPeriodicJob({
    name: "flow-coordinator-sweep",
    envVar: FLOW_TICK_ENV_VAR, // informational for the disabled log line
    defaultHours: DEFAULT_TICK_MINUTES / 60,
    intervalMs,
    initialDelayMs: Math.min(intervalMs, 60_000),
    run: async () => {
      const { resumed } = await coordinator.sweep(intervalMs);
      if (resumed > 0) {
        logger.info({ resumed }, "flow coordinator sweep: resumed stale running flows");
      }
    },
  });
}
