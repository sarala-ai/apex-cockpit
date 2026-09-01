/**
 * "Does this step run anything?" — asked once, in one place.
 *
 * The step model became `run · agent · gate`. The writers were updated; the
 * readers were not, and each one that was left behind asks the OLD question —
 * `onEnter.type === "routine"`, or `config.automation`, or a `routineId` —
 * while meaning the new one. That mismatch has produced the same bug five
 * times: pipeline health warning "nothing runs here automatically" over a
 * correctly wired stage, a greyed-out "Re-run this step", a retry that threw
 * `automation_not_configured`, a retry plan that found no compatible
 * automation, and "Retry previous step…" never offering an upstream run.
 *
 * Every one of them was found by accident. The reason there were five rather
 * than one is that the predicate had SIX independent spellings across
 * `server/src/services`, `server/src/routes`, `server/src/services/
 * pipelines-aggregation.ts`, the UI and the CLI, and no layer could reuse
 * another's. This module exists so there is one, reachable from all of them —
 * the only change that makes the class closable rather than merely emptier.
 *
 * The rule it encodes: `routine`, `run` and `agent` are all ENTRY STEPS. A
 * routine is one KIND of entry step, not a synonym for having one. Ask
 * `stageEntryStepRef` when you mean "is there a step here"; keep asking about
 * `routineId` only when you specifically mean a routine — looking up its
 * revision, binding its env, garbage-collecting it.
 */

/** The three things a stage's entry step can be. `gate` is not among them:
 *  a gate is `stage.kind === "review"`, not an `onEnter` member. */
export type StageEntryStepKind = "routine" | "run" | "agent";

export interface StageEntryStepRef {
  /** The ledger's `automationId` for this step — the key `pipeline_automation_
   *  executions` rows are written and looked up under. */
  id: string;
  kind: StageEntryStepKind;
  /** Set for `routine` only. Null for `run` and `agent`, which have no
   *  routine — and requiring it is precisely how those two kinds got refused. */
  routineId: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The entry step declared on a stage config, whatever kind it is.
 *
 * `stageId` supplies the fallback step id (`<stage>:on_enter`), which is the
 * id the ledger has always used when the author did not write one. It is a
 * parameter rather than read off the config because callers hold the stage row
 * and the config separately about half the time.
 */
export function stageEntryStepRef(config: unknown, stageId: string): StageEntryStepRef | null {
  const onEnter = asRecord(asRecord(config)?.onEnter);
  if (!onEnter) return null;
  const id = trimmed(onEnter.id) || `${stageId}:on_enter`;

  if (onEnter.type === "routine") {
    const routineId = trimmed(onEnter.routineId);
    // A routine step with no routine is not a step. It is an incomplete
    // config, and reporting one would send the retry machinery looking up a
    // routine that is not there.
    return routineId ? { id, kind: "routine", routineId } : null;
  }
  if (onEnter.type === "run") {
    // A run with no target runs nothing — the same fail-closed reading
    // `readRunTarget` takes, and for the same reason: a target whose type was
    // omitted must never be treated as runnable.
    return asRecord(onEnter.target) ? { id, kind: "run", routineId: null } : null;
  }
  if (onEnter.type === "agent") {
    return trimmed(onEnter.promptTemplate) ? { id, kind: "agent", routineId: null } : null;
  }
  return null;
}

/** Whether this stage runs anything on entry. The question five stale readers
 *  were trying to ask. */
export function stageHasEntryStep(config: unknown, stageId: string): boolean {
  return stageEntryStepRef(config, stageId) !== null;
}

/** The routine behind this stage's entry step, or null when it has none —
 *  because it is a `run`/`agent` step, or because there is no step at all.
 *  Use this ONLY where a routine is genuinely required. */
export function stageEntryRoutineId(config: unknown, stageId: string): string | null {
  return stageEntryStepRef(config, stageId)?.routineId ?? null;
}
