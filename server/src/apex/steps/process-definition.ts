/**
 * THE process definition — one shape, database-backed.
 *
 * This module used to be the flow front-end's `definition.ts`, where the same types were
 * parsed out of `apex flows show <name> --output json` (git YAML in apex-core).
 * The founder overruled that: *"we should add those nodes cleanly as pipeline
 * steps or features and the git should be discarded and moved to db for
 * schema"* (docs/architecture/execution-substrate.md §5). So the SHAPE stayed
 * and the SOURCE changed: a process definition is now projected from a
 * pipeline and its stage rows (`processDefinitionFromStages` below), and
 * nothing shells the CLI for it.
 *
 * What survives unchanged is deliberate. Everything that reasons ABOUT a
 * process rather than executing it — the decision brief's "what happens next",
 * its risk section, its review passes, and `findChangeRequestTarget` — walks
 * this node list. Keeping the walked shape identical is what let those move
 * across intact instead of being rewritten against a second vocabulary, which
 * is the outcome the merge exists to prevent.
 *
 * The snake_case config keys (`prompt_template`, `pass_criteria`, `on_fail`,
 * `ticket_type`) are not a leftover: they are the step executor's own field
 * vocabulary (`StepSpec` in ./step-executor.ts). One vocabulary, one place.
 */
import { STEP_ON_FAIL_RE, type RunTarget, type StepKind } from "./step-executor.js";

export const PROCESS_ON_FAIL_RE = STEP_ON_FAIL_RE;

/** A `run` step, as a definition states it. The target is the pluggable half;
 *  the criteria it is judged by live in `acceptance`, not here. */
export type RunStepDefinition = {
  target: RunTarget;
};

export type AgentStepDefinition = {
  prompt_template: string;
  budget?: Record<string, unknown> | null;
  /** A permission profile declaration, read defensively — see
   *  ./run-policy.ts, which derives a policy from whatever shape shows up. */
  permissions?: unknown;
};

export type GateStepDefinition = {
  mode: "approve" | "notify";
  prompt?: string | null;
  /** Review-pass identifiers this gate asks the approver. The vocabulary and
   *  the question text both live in the review-pass catalogue
   *  (./review-passes.ts); never restated here. */
  requires?: string[] | null;
  /** Where a `request_changes` decision at this gate sends the work back to.
   *  Named the same as a review stage's `requestChangesToStageKey` so there is
   *  ONE mental model. Absent means DERIVE it (see findChangeRequestTarget). */
  request_changes_to?: string | null;
};

/** One step of a process — the definition-side counterpart of a `StepSpec`.
 *  `id` is the stage key.
 *
 *  Three kinds, distinguished by WHO executes (see ./step-executor.ts): `run`
 *  costs nothing, `agent` costs tokens, `gate` costs a person's attention.
 *  `acceptance` is the contract the SERVER evaluates against the step's
 *  outcome, and it is deliberately on the step rather than inside one kind's
 *  config — a `run` and an `agent` are judged the same way, by the same
 *  evaluator, and the moment that stopped being true a model would be
 *  attesting to its own success. */
export type ProcessStep = {
  id: string;
  kind: StepKind;
  run?: RunStepDefinition | null;
  agent?: AgentStepDefinition | null;
  gate?: GateStepDefinition | null;
  /** Rendered criteria, or null when the step declares no server-checkable
   *  contract. `enforced: false` records criteria verbatim while saying out
   *  loud that nothing is checking them — the honest alternative to prose that
   *  reports green having checked nothing. */
  acceptance?: { criteria: string; enforced: boolean } | null;
  on_fail: string;
};

export type ProcessDefinition = {
  /** The pipeline's key — stable, human-readable, unique per company. */
  name: string;
  version: string;
  description: string;
  ticket_type: string;
  /**
   * The stages that EXECUTE something: a `run`, an `agent`, or a `gate`.
   *
   * Deliberately NOT every stage. A board column where a person does the work
   * and then drags the card — which is what `pipeline_stages.kind = 'working'`
   * with no `onEnter` means, and what the DEFAULT stages are — executes
   * nothing. It is a waiting position between steps, not a step.
   *
   * An earlier draft projected those as a `gate` in `notify` mode so that
   * nothing was dropped. That was wrong, and wrong in the expensive direction:
   * it labelled the single most common stage in the product a gate, which
   * would have put "the process pauses for another approval" on a decision
   * brief about a column where no approval exists. Silence about a column with
   * no consequence is accurate; inventing a consequence is not.
   *
   * See the note on the stage-kind overlap in services/pipelines.ts
   * (`stageProcessStep`) for why this boundary is currently drawn here rather
   * than resolved properly.
   */
  steps: ProcessStep[];
};

export type ChangeRequestTarget =
  | { found: true; step: ProcessStep; index: number; source: "declared" | "derived" }
  | { found: false; reason: "no_prior_agent_step" | "declared_target_missing" | "declared_target_not_agent" };

/**
 * Where a `request_changes` decision at `gateStepKey` sends the work back to.
 *
 * Lives here, not in whichever host is running the case, because two surfaces
 * must agree: the host (which re-arms the step) and the decision brief (which
 * tells the founder BEFORE they click what requesting changes will do).
 * Divergence would be a lie in the UI, so both import this.
 *
 * Resolution order:
 * 1. DECLARED — the gate's `request_changes_to`. A declared target that does
 *    not exist, or is not an agent step, is a classified failure rather than a
 *    silent fallback: the author asked for something specific.
 * 2. DERIVED — the nearest PRIOR step of kind `agent`, scanning backwards.
 *    That is the authoring step: the only kind that turns an instruction into a
 *    fresh artifact, and therefore the only one that can act on a reviewer's
 *    comment.
 *
 * Steps BETWEEN the target and the gate are deliberately not skipped — they
 * re-run as the case advances forward again, so the gate never reopens over
 * work that has not passed the same automated bar.
 *
 * `no_prior_agent_step` (e.g. the feature lifecycle's `promote` gate, which is
 * step 0) means changes cannot be requested there at all; the caller must say
 * so rather than invent a target.
 */
export function findChangeRequestTarget(
  definition: ProcessDefinition,
  gateStepKey: string,
): ChangeRequestTarget {
  const gateIndex = definition.steps.findIndex((step) => step.id === gateStepKey);
  if (gateIndex < 0) return { found: false, reason: "no_prior_agent_step" };
  const declared = definition.steps[gateIndex]?.gate?.request_changes_to?.trim();
  if (declared) {
    const index = definition.steps.findIndex((step) => step.id === declared);
    if (index < 0) return { found: false, reason: "declared_target_missing" };
    const step = definition.steps[index] as ProcessStep;
    if (step.kind !== "agent" || !step.agent) return { found: false, reason: "declared_target_not_agent" };
    return { found: true, step, index, source: "declared" };
  }
  for (let index = gateIndex - 1; index >= 0; index -= 1) {
    const step = definition.steps[index] as ProcessStep;
    if (step.kind === "agent" && step.agent) return { found: true, step, index, source: "derived" };
  }
  return { found: false, reason: "no_prior_agent_step" };
}
