/**
 * The periodic pipeline step sweep — the RECOVERY half of advancement.
 *
 * Advancement is event-driven where events exist: entering a stage runs its
 * entry step, a gate decision moves the case. This sweep exists for the one
 * place events are not enough — a case parked on a bounded agent run whose
 * completion nobody observed, because the server restarted, the process died,
 * or heartbeat deferred the wake and promoted it into a run the case never
 * learned about.
 *
 * Without it, those cases strand. Not visibly stuck — parked, looking exactly
 * like a case whose agent is still working, forever. That failure mode is why
 * this is not optional machinery: a queue that silently loses work is worse
 * than one that fails loudly, because nobody goes looking.
 *
 * At-least-once, deliberately. A case is only considered stale after a FULL
 * tick without its row moving, so an actively-advancing case is never
 * double-driven, and the recovery itself compare-and-sets on `step_status` so
 * two overlapping ticks cannot both complete the same step.
 *
 * `waiting_gate` is NOT swept, and that is a design decision rather than an
 * omission — see `sweepWaitingAgentCases`. A gate waiting on a person is not a
 * stuck case.
 */
import type { Db } from "@paperclipai/db";
import { startPeriodicJob } from "../../lib/periodic-job.js";
import { logger } from "../../middleware/logger.js";
import { pipelineService } from "../../services/pipelines.js";

export const PIPELINE_STEP_TICK_ENV_VAR = "APEX_PIPELINE_TICK_MINUTES";
const DEFAULT_TICK_MINUTES = 5;

export function pipelineStepTickIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[PIPELINE_STEP_TICK_ENV_VAR];
  if (raw === undefined || raw.trim() === "") return DEFAULT_TICK_MINUTES * 60_000;
  const minutes = Number(raw);
  // A negative or unparseable interval falls back to the default rather than
  // disabling the sweep by accident. Disabling is spelled `0`, on purpose.
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_TICK_MINUTES * 60_000;
  return minutes * 60_000;
}

export function startPipelineStepSweep(
  db: Db,
  options: { service?: ReturnType<typeof pipelineService>; intervalMs?: number } = {},
): () => void {
  const intervalMs = options.intervalMs ?? pipelineStepTickIntervalMs();
  const service = options.service ?? pipelineService(db);
  return startPeriodicJob({
    name: "pipeline-step-sweep",
    envVar: PIPELINE_STEP_TICK_ENV_VAR,
    defaultHours: DEFAULT_TICK_MINUTES / 60,
    intervalMs,
    // Never on boot: a server that has just started has not yet had a chance
    // to observe anything, so every parked case would look stale at once.
    initialDelayMs: Math.min(intervalMs, 60_000),
    run: async () => {
      const { examined, recovered } = await service.sweepWaitingAgentCases(intervalMs);
      if (recovered > 0) {
        logger.info({ examined, recovered }, "pipeline step sweep: recovered cases parked on an agent step");
      }
    },
  });
}
