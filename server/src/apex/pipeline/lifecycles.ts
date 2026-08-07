/**
 * Seed the four typed-lifecycle pipelines (chore, bug, design-change,
 * feature) as database-backed `pipelines` rows.
 *
 * WHY: these four lifecycles used to live as git YAML in apex-core
 * (`apex/core/flows/{chore,bug,design-change,feature}.yml`), read at
 * request time via `apex flows show --output json`. That seam is being
 * deleted along with the flow front-end
 * (docs/architecture/execution-substrate.md §5-6): a typed lifecycle is now
 * just a pipeline definition, the same primitive every other board in the
 * cockpit already uses, seeded once the way built-in agents are seeded from
 * files into the database (see the agent seeder for the pattern this
 * mirrors). There is no longer a live apex-core process for the cockpit to
 * ask "what does a bug ticket's lifecycle look like" — the answer has to be
 * a row here.
 *
 * This file is modeled closely on `./seed.ts` (the apex-tower lifecycle
 * seeder written for the earlier flow migration): same idempotency
 * approach — look up by (companyId, key), return early if the row already
 * exists — and the same use of `pipelineService(db).createPipeline` /
 * `svc.createTransition`. Read that file first if this one is confusing;
 * it is deliberately not a new pattern.
 *
 * STEP-KIND MODEL — three kinds, not four (docs/architecture/process-definition.md
 * §2a). The distinction that matters is WHO executes a step, because that is
 * the only axis that changes cost, accountability, and blast radius:
 *
 *   `run`   — the machine, deterministically. Costs nothing. The target is
 *             pluggable: `{ type: "workflow", workflow, params }` for an APEX
 *             workflow, or `{ type: "command", tool, args }` for anything
 *             else. A flow YAML `check` node is NOT a fourth kind — it is a
 *             `run` step whose failure holds the stage rather than routing
 *             it, which is `on_fail` behaviour (always "pause" here; see
 *             below), not a different identity.
 *   `agent` — a model, bounded by a permission profile. Costs tokens. Output
 *             is a proposal evaluated against the stage's `acceptance`
 *             contract, never self-attested.
 *   `gate`  — a person. Costs attention. Stage kind `"review"`.
 *
 * A former flow-YAML `pass_criteria` (on both `check` and `agent` nodes)
 * becomes the STAGE's own `acceptance.criteria` — that contract already
 * exists and is already server-evaluated, so nothing invents a second
 * acceptance mechanism. But the v1 acceptance grammar only actually
 * evaluates `file_exists:<path>` and `pr_exists:<repo>#<head>`
 * (`isMachineEvaluableAcceptance` in `../steps/agent-step.js`); anything
 * else is prose to this server. A stage's acceptance contract refuses
 * unverifiable prose at authoring time (`assertStageAcceptanceIsCheckable`
 * in `services/pipelines.ts`) because a check that always reports green
 * having checked nothing is worse than declaring no check at all — so every
 * node below whose criteria isn't in that grammar is written with
 * `acceptance.disabled: true`: the wording is preserved verbatim for a human
 * to read, and the seeder says out loud that nothing enforces it, rather
 * than smuggling prose past the same guard that would reject it if a person
 * typed it into the editor. Only `design_change`'s `board_diff` node
 * (`pr_exists:sarala-ai/apex-design#design/{{identifier}}`) is a REAL
 * enforcing contract as a result — every other agent/former-check node's
 * acceptance is descriptive only. This asymmetry is the honest state of the
 * v1 grammar, not an oversight, and it is computed here, not hand-picked, so
 * it can never drift from what the server actually enforces.
 *
 * TRANSLATION RULES from flow YAML to pipeline stages (one flow node -> one
 * stage, in declaration order, followed by two terminal stages):
 *
 *   - stage `key`  = the YAML node's `id`.
 *   - stage `name` = a Title Case rendering of that id.
 *   - node kind `gate` -> stage kind `"review"`; every other node kind
 *     (`workflow`, `check`, `agent`) -> stage kind `"working"`.
 *   - `workflow` node -> `onEnter: { type: "run", target: { type: "workflow", ... } }`
 *   - `check` node    -> `onEnter: { type: "run", target: { type: "command", ... } }`,
 *                        stage `acceptance` carries the pass_criteria (see above)
 *   - `agent` node    -> `onEnter: { type: "agent", promptTemplate, budget }`,
 *                        stage `acceptance` carries the flow node's acceptance string
 *   - `gate` node     -> `requireApproval: true`, `approver: { kind: "any_human" }`,
 *     `gate: { mode: "approve", prompt, requires }`, plus the three
 *     approve/reject/request-changes routes a review stage requires.
 *
 * `on_fail: pause` — EVERY node in all four YAMLs declares this, with no
 * exception. `pause` is expressed by OMITTING `onFailureToStageKey`
 * entirely: per `PipelineStageConfig.onEnter`'s own doc comment, "a failure
 * with no failure route HOLDS the stage." That is exactly flow-YAML
 * `pause` semantics, so no failure-route field is ever written here. Do not
 * "helpfully" wire one in — it would silently reintroduce an auto-advance
 * these lifecycles never had.
 *
 * A gate's `requestChangesToStageKey` sends rework back to the nearest
 * PRIOR *agent*-kind stage — the last place tokens were spent producing the
 * artifact under review — never to a `run` (workflow/command) stage, which
 * has nothing to redo. When a gate has no prior agent stage (chore's flows
 * have no gates; `promote` in `feature` is the first node full stop), the
 * field is omitted rather than pointed at nothing.
 */

import { and, eq } from "drizzle-orm";
import { pipelines } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  pipelineService,
  type PipelineActor,
  type PipelineStageConfig,
  type PipelineStageKind,
} from "../../services/pipelines.js";
import { isMachineEvaluableAcceptance } from "../steps/agent-step.js";
import { validateReviewPassIds } from "../steps/review-passes.js";
import {
  APEX_AGENT_KEYS,
  apexAgentPermissionProfile,
  type ApexAgentKey,
} from "../../services/apex-agent-roster.js";
import type { RunContract } from "./contract-targets.js";

/** One YAML flow node, in the shape apex-core's flow YAML already used —
 *  except where APEX-38 replaced a hardcoded tool with a CONTRACT.
 *
 *  A `check` node may name a concrete `{tool, args}` (the YAML shape) or a
 *  `{contract: "checks_pass"}`; a `workflow` node may name a concrete
 *  `{workflow, params}` or a `{contract: "deployed"}`. A contract target
 *  resolves at DISPATCH time from the pipeline's project workspace config
 *  (`checkCommand` / `deployWorkflow` — see ./contract-targets.ts), because
 *  the tool is a fact about the PROJECT's stack, not about the process: the
 *  seeded `pytest tests/unit` and `cloud_run_deploy` were wrong for every
 *  non-Python, non-Cloud-Run project, and a case failed its checks on tool
 *  mismatch rather than on the work. */
type LifecycleNode =
  | {
      id: string;
      kind: "workflow";
      workflow: { workflow: string; params: Record<string, unknown> } | { contract: RunContract };
    }
  | {
      id: string;
      kind: "check";
      check:
        | { tool: string; args: string[]; pass_criteria: string }
        | { contract: RunContract; pass_criteria: string };
    }
  | {
      id: string;
      kind: "agent";
      agent: {
        prompt_template: string;
        budget: { max_turns: number; timeout_seconds: number } | null;
        acceptance: string;
        /**
         * WHO executes this step — a key from the built-in agent roster
         * (server/src/services/apex-agent-roster.ts).
         *
         * Required, and that is the point of this field. Before it existed,
         * every agent step below declared a task with an acceptance contract
         * and named nobody, so `resolveStepExecutorAgent` fell through to "the
         * company's single assignable agent" — a guess about who spends tokens
         * under which permission profile, made silently, at commission time.
         *
         * The key selects a PERMISSION SURFACE, not a job title: the task is
         * already fully carried by `prompt_template` + the stage's acceptance
         * contract, and what a step cannot carry is what its executor is
         * allowed to touch. Which is why one key appears twice below — the bug
         * lifecycle's fix step and the feature lifecycle's task step are
         * different work done with the same hands.
         */
        agent_key: ApexAgentKey;
      };
    }
  | {
      id: string;
      kind: "gate";
      gate: { mode: "approve"; prompt: string; requires: string[] | null };
    };

export type LifecycleDefinition = {
  key: string;
  name: string;
  description: string;
  version: string;
  ticketType: string;
  stages: Array<{ key: string; name: string; kind: PipelineStageKind; config: PipelineStageConfig }>;
  transitions: Array<{ from: string; to: string }>;
};

/** Title Case a `snake_case` / `kebab-case` node id for the stage's `name`. */
function titleCaseId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/** Collapse a (possibly multi-line, YAML block-scalar) description to one paragraph. */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A stage-level acceptance contract for a former check/agent node's
 * criteria string. `disabled` is computed from the same grammar check the
 * server itself enforces (`isMachineEvaluableAcceptance`), never hand-picked
 * per node — so this can never drift from what `services/pipelines.ts`
 * actually evaluates.
 */
function acceptanceFor(criteria: string): NonNullable<PipelineStageConfig["acceptance"]> {
  return isMachineEvaluableAcceptance(criteria)
    ? { criteria }
    : { criteria, disabled: true };
}

/**
 * Build a lifecycle's stages + transitions from its ordered node list.
 *
 * `done` and `cancelled` are appended after every declared node — every
 * lifecycle needs both a completion stage and, for lifecycles with gates, a
 * reject destination. Chore has no gate, so nothing ever transitions to
 * `cancelled`, but the stage still has to exist: `createPipeline` requires
 * at least one `done` and one `cancelled` stage per pipeline.
 */
function buildStagesAndTransitions(nodes: LifecycleNode[]): {
  stages: LifecycleDefinition["stages"];
  transitions: LifecycleDefinition["transitions"];
} {
  const stages: LifecycleDefinition["stages"] = [];
  const transitions: LifecycleDefinition["transitions"] = [];

  // Nearest-prior-agent-stage tracking for gate requestChangesToStageKey.
  let nearestPriorAgentKey: string | null = null;

  nodes.forEach((node, index) => {
    const next = index + 1 < nodes.length ? nodes[index + 1]!.id : "done";
    const name = titleCaseId(node.id);

    if (node.kind === "workflow") {
      stages.push({
        key: node.id,
        name,
        kind: "working",
        config: {
          onEnter: {
            type: "run",
            target:
              "contract" in node.workflow
                ? { type: "contract", contract: node.workflow.contract }
                : { type: "workflow", workflow: node.workflow.workflow, params: node.workflow.params },
            onSuccessToStageKey: next,
            // on_fail: pause -> no onFailureToStageKey. See file header.
          } as unknown as PipelineStageConfig["onEnter"],
        },
      });
      transitions.push({ from: node.id, to: next });
      return;
    }

    if (node.kind === "check") {
      stages.push({
        key: node.id,
        name,
        kind: "working",
        config: {
          onEnter: {
            type: "run",
            target:
              "contract" in node.check
                ? { type: "contract", contract: node.check.contract }
                : { type: "command", tool: node.check.tool, args: node.check.args },
            onSuccessToStageKey: next,
          } as unknown as PipelineStageConfig["onEnter"],
          acceptance: acceptanceFor(node.check.pass_criteria),
        },
      });
      transitions.push({ from: node.id, to: next });
      return;
    }

    if (node.kind === "agent") {
      stages.push({
        key: node.id,
        name,
        kind: "working",
        config: {
          onEnter: {
            type: "agent",
            promptTemplate: node.agent.prompt_template,
            budget: node.agent.budget,
            // WHO executes, and therefore WHAT IT MAY TOUCH. The profile is
            // READ FROM the roster entry rather than restated here, so a
            // stage and the agent it names can never disagree about blast
            // radius — there is one place the answer lives, and a step that
            // names an agent that does not exist throws at seed time instead
            // of resolving to nobody at commission time.
            agentKey: node.agent.agent_key,
            permissions: { profile: apexAgentPermissionProfile(node.agent.agent_key) },
            onSuccessToStageKey: next,
          } as unknown as PipelineStageConfig["onEnter"],
          acceptance: acceptanceFor(node.agent.acceptance),
        },
      });
      transitions.push({ from: node.id, to: next });
      nearestPriorAgentKey = node.id;
      return;
    }

    // node.kind === "gate"
    const requires = node.gate.requires ?? null;
    if (requires) validateReviewPassIds(requires);
    const requestChangesToStageKey = nearestPriorAgentKey;
    stages.push({
      key: node.id,
      name,
      kind: "review",
      config: {
        requireApproval: true,
        approver: { kind: "any_human" },
        gate: {
          mode: node.gate.mode,
          prompt: node.gate.prompt,
          requires,
        },
        approveToStageKey: next,
        rejectToStageKey: "cancelled",
        ...(requestChangesToStageKey ? { requestChangesToStageKey } : {}),
      },
    });
    transitions.push({ from: node.id, to: next });
    transitions.push({ from: node.id, to: "cancelled" });
    if (requestChangesToStageKey) {
      transitions.push({ from: node.id, to: requestChangesToStageKey });
    }
  });

  stages.push({ key: "done", name: "Done", kind: "done", config: {} });
  stages.push({ key: "cancelled", name: "Cancelled", kind: "cancelled", config: {} });

  return { stages, transitions };
}

// ---------------------------------------------------------------------------
// The four lifecycles, transcribed VERBATIM from apex/core/flows/*.yml —
// with ONE deliberate departure (APEX-38): the check/deploy nodes that
// hardcoded `pytest` / `cloud_run_deploy` now declare contracts instead;
// each is marked inline where it happens.
// Prompt templates, acceptance strings, gate prompts, tool args, and
// pass_criteria are copied exactly, including `{{identifier}}` / `{{title}}`
// / `{{acceptance}}` tokens — those are interpolated downstream by whatever
// now plays the flow coordinator's role, not by this seeder.
// ---------------------------------------------------------------------------

// Retained as the record of what the chore lifecycle was, and as the input to
// whoever expresses it as a single workflow. It is NOT seeded — see the note on
// LIFECYCLE_DEFINITIONS for why a gateless, agentless chain is not a process.
export const CHORE_NODES: LifecycleNode[] = [
  { id: "run", kind: "workflow", workflow: { workflow: "cloud_run_deploy", params: {} } },
  {
    id: "verify",
    kind: "check",
    check: { tool: "ci_status_check", args: ["--ref", "HEAD"], pass_criteria: "exit_code == 0" },
  },
  { id: "land", kind: "workflow", workflow: { workflow: "apex_release", params: {} } },
];

const BUG_NODES: LifecycleNode[] = [
  {
    id: "failing_signal",
    kind: "check",
    check: { tool: "ci_failure_signal", args: [], pass_criteria: "failure_detected == true" },
  },
  {
    id: "repro_fix",
    kind: "agent",
    agent: {
      prompt_template:
        "Reproduce the failing signal from node 'failing_signal', identify " +
        "root cause, and implement a fix. Work in a bounded worktree; " +
        "checkpoint after reproducing before attempting the fix.\n",
      budget: { max_turns: 30, timeout_seconds: 3600 },
      acceptance: "a failing test reproducing the bug now passes locally",
      agent_key: APEX_AGENT_KEYS.implementer,
    },
  },
  {
    id: "tests",
    kind: "check",
    // Formerly `pytest tests/unit -q`, hardcoded (APEX-38). The contract is
    // "checks pass"; WHICH suite proves it is the project's own declaration.
    check: { contract: "checks_pass", pass_criteria: "exit_code == 0" },
  },
  {
    id: "diff_review",
    kind: "gate",
    gate: {
      mode: "approve",
      prompt: "Review the fix diff — CI green, delta against the failing test.",
      requires: ["system_compatibility"],
    },
  },
  // Formerly the `cloud_run_deploy` workflow, hardcoded (APEX-38). A project
  // that declares no deploy workflow HOLDS here with an honest message.
  { id: "deploy", kind: "workflow", workflow: { contract: "deployed" } },
];

const DESIGN_CHANGE_NODES: LifecycleNode[] = [
  {
    id: "board_diff",
    kind: "agent",
    agent: {
      prompt_template:
        'Author the design-board change requested by ticket {{identifier}} ("{{title}}") and open a pull request carrying the updated .penpot artifact. The ticket\'s agent brief specifies the target Penpot file, page/board, design repo, artifact path, and the exact change to make; the ticket body says what the change is for.\n\n\n' +
        "Work ONLY through the apex CLI so every step rides the audited tool path (prefix each write invocation with APEX_EXECUTION_MODE=apply and always pass --output json):\n\n" +
        "1. Apply the change to the live Penpot file:\n" +
        "`apex run penpot update-file` with the file id and a JSON array of Penpot update-file change operations (e.g. add-obj).\n\n" +
        "2. Export the updated file: `apex run penpot export-file` to a temporary local .penpot path.\n\n" +
        "3. Create branch `design/{{identifier}}` on the design repo:\n" +
        "`apex run github_repo create-branch`.\n\n" +
        "4. Commit the export to that branch at the ticket's artifact path:\n" +
        "`apex run github_repo put-file` with content_file pointing at the exported .penpot (binary-safe).\n\n" +
        "5. Open the pull request: `apex run github_repo\n" +
        "open-pull-request` with head `design/{{identifier}}`, titled for the ticket, body linking back to {{identifier}}.\n\n\n" +
        "Acceptance (machine-checked when this run completes):\n" +
        "{{acceptance}}\n",
      budget: { max_turns: 25, timeout_seconds: 1800 },
      acceptance: "pr_exists:sarala-ai/apex-design#design/{{identifier}}",
      agent_key: APEX_AGENT_KEYS.designEngineer,
    },
  },
  {
    id: "design_gate",
    kind: "gate",
    gate: {
      mode: "approve",
      prompt: "Review the design-board diff (.penpot pull request) — seconds of board review.",
      requires: ["customer_hat", "cognitive_load"],
    },
  },
  {
    id: "merge",
    kind: "workflow",
    workflow: {
      workflow: "design-pr-merge",
      params: { repo: "sarala-ai/apex-design", head: "design/{{identifier}}" },
    },
  },
];

const FEATURE_NODES: LifecycleNode[] = [
  {
    id: "promote",
    kind: "gate",
    gate: {
      mode: "approve",
      prompt: "Gate 1: Promote — is it worth doing. Seconds.",
      requires: null,
    },
  },
  {
    id: "spec",
    kind: "agent",
    agent: {
      prompt_template:
        "Draft the spec: task breakdown plus each task's machine-checkable acceptance criteria.\n",
      budget: { max_turns: 25, timeout_seconds: 3600 },
      acceptance: "spec document exists with a task list and acceptance criteria per task",
      agent_key: APEX_AGENT_KEYS.specifier,
    },
  },
  {
    id: "spec_design_gate",
    kind: "gate",
    gate: {
      mode: "approve",
      prompt:
        "Gate 2: Spec approval — the load-bearing gate. Approving pre-approves all derived tasks, explicitly.\n",
      requires: ["customer_hat", "cognitive_load", "design", "system_compatibility", "reversibility"],
    },
  },
  {
    id: "tasks",
    kind: "agent",
    agent: {
      prompt_template:
        "Execute the approved spec's task breakdown, one bounded session per " +
        "PR-sized unit; batch same-file tasks, separate-PR tasks get separate " +
        "sessions per the spec's dependency edges.\n",
      budget: { max_turns: 40, timeout_seconds: 7200 },
      acceptance: "each task in the approved spec has a corresponding diff",
      // The SAME agent as the bug lifecycle's `repro_fix`. Different work,
      // identical hands — see the `agent_key` doc on LifecycleNode.
      agent_key: APEX_AGENT_KEYS.implementer,
    },
  },
  {
    id: "task_checks",
    kind: "check",
    // Formerly `pytest tests/unit -q`, hardcoded (APEX-38) — a feature ticket
    // on a Node project failed checks on tool mismatch, not on the work.
    check: {
      contract: "checks_pass",
      pass_criteria: "exit_code == 0 for every task's diff",
    },
  },
  {
    id: "diff_gate",
    kind: "gate",
    gate: {
      mode: "approve",
      prompt:
        "Gate 3: Diff review — the PR(s) with CI + evals green; a delta against a spec already approved, therefore fast.\n",
      requires: ["naming"],
    },
  },
  // Formerly the `cloud_run_deploy` workflow, hardcoded (APEX-38).
  { id: "deploy", kind: "workflow", workflow: { contract: "deployed" } },
];

function lifecycle(input: {
  key: string;
  name: string;
  description: string;
  version: string;
  ticketType: string;
  nodes: LifecycleNode[];
}): LifecycleDefinition {
  const { stages, transitions } = buildStagesAndTransitions(input.nodes);
  return {
    key: input.key,
    name: input.name,
    description: collapseWhitespace(input.description),
    version: input.version,
    ticketType: input.ticketType,
    stages,
    transitions,
  };
}

/**
 * THREE processes are seeded, not four. `chore` is deliberately absent, and
 * `CHORE_NODES` above is kept only as the record of what it was.
 *
 * The bar: a sequence with no gate and no agent step should not be a process.
 * Cases, stages, leases, versions and sweeps exist to govern non-determinism
 * and to hold work for a human. A chore lifecycle — two workflow invocations
 * and a check — has neither, so the machinery buys nothing and costs a row,
 * a board column and a concept.
 *
 * That bar was CHECKED against this codebase rather than assumed, because it
 * would have been easy to be wrong about:
 *
 *  - BOARD PRESENCE. A ticket does not need a case to be visible. The issues
 *    board (ui/src/pages/Issues.tsx -> GET /companies/:id/issues) renders from
 *    `issues.status` with no join to `pipeline_cases` anywhere. What a chore
 *    ticket loses is a CARD ON THE PIPELINES BOARD, which renders only from
 *    case rows — not visibility, and not its status, assignee or audit trail.
 *  - FAILURE SURFACING. Nothing is lost here because nothing was there: a
 *    `step_held` / `automation_failed` event today produces no notification,
 *    no inbox item and no sidebar badge. It is a row in `pipeline_case_events`
 *    that a person only sees by opening that case's detail page. (That is a
 *    real gap for the three processes that ARE seeded, and it is reported
 *    rather than fixed here.)
 *  - WHAT ELSE A CASE GIVES. Parent/child rollup, blockers and leases are the
 *    load-bearing ones, and a leaf, single-shot, non-concurrent chore uses
 *    none of them: rollup gates a parent on its children, blockers model
 *    cross-case dependencies, leases arbitrate contention between actors.
 *
 * `chore` REMAINS A TICKET TYPE. Nothing here removes the word from the
 * product — a chore ticket keeps its type, status, assignee, board presence
 * and audit trail like any other. The only claim is that its lifecycle does
 * not need stages.
 */
export const LIFECYCLE_DEFINITIONS: LifecycleDefinition[] = [
  lifecycle({
    key: "bug",
    name: "Bug",
    description: `A failing signal (test/alert) triggers a bounded agent step to reproduce
      and fix, machine-verified by the test suite, then a single diff-review
      gate before deploy.`,
    version: "1.0",
    ticketType: "bug",
    nodes: BUG_NODES,
  }),
  lifecycle({
    key: "design-change",
    name: "Design change",
    description: `A bounded agent step authors a design-board change and opens a .penpot
      pull request on the design repo, a founder reviews it at a single gate,
      then the merge workflow lands it.`,
    version: "1.2",
    ticketType: "design-change",
    nodes: DESIGN_CHANGE_NODES,
  }),
  lifecycle({
    key: "feature",
    name: "Feature",
    description: `Promote gate, spec drafted by an agent and approved at a load-bearing
      gate (pre-approves all derived tasks), a batch of bounded agent tasks
      each machine-checked, a diff-review gate, then deploy.`,
    version: "1.0",
    ticketType: "feature",
    nodes: FEATURE_NODES,
  }),
];

/**
 * Idempotently seed the four lifecycle pipelines for a company.
 *
 * Looks each up by (companyId, key) first — same idempotency contract as
 * `./seed.ts` — and returns which keys were newly seeded vs. already present
 * rather than throwing, so a caller can run this on every startup without
 * worrying about duplicate rows.
 *
 * `version` / `ticketType`: `pipelineService(db).createPipeline` does not yet
 * accept these two fields (they are new columns from migration
 * `0170_pipeline_step_kinds.sql`, not yet threaded through that function's
 * input type). Rather than editing `services/pipelines.ts` — out of scope
 * for this change, and being edited concurrently elsewhere — this seeder
 * writes them with a direct `db.update(pipelines)...` immediately after
 * `createPipeline` returns. This is a seam: `createPipeline`'s input type
 * should grow `version`/`ticketType` fields so every future caller (not just
 * this seeder) can set them at creation time instead of in a follow-up
 * write. Left for whoever picks up `services/pipelines.ts` next.
 *
 * `onEnter.type: "run" | "agent"` with a pluggable `run` target: at the time
 * this file was written, `services/pipelines.ts`'s own `PipelineStageConfig`
 * still spells these `run_workflow` / `run_check` / `run_agent` (the
 * four-kind model process-definition.md §2a retires). This seeder is
 * written against the THREE-kind, pluggable-target contract that document
 * specifies as the target shape — `services/pipelines.ts` needs the
 * matching rename before these seeded stages will round-trip through its
 * read helpers (`stageWorkflowEntry` and friends). That rename is explicitly
 * called out in process-definition.md §2 as needing to happen BEFORE
 * seeding, precisely so it never becomes a data migration over rows like
 * these — so this file should be treated as leading that rename, not
 * following a contract that already landed.
 */
export async function seedLifecyclePipelines(
  db: Db,
  input: { companyId: string; projectId?: string | null; actor?: PipelineActor },
): Promise<{ seeded: string[]; existing: string[] }> {
  const svc = pipelineService(db);
  const actor: PipelineActor = input.actor ?? { type: "system" };

  const seeded: string[] = [];
  const existing: string[] = [];

  for (const definition of LIFECYCLE_DEFINITIONS) {
    const already = await db
      .select({ id: pipelines.id })
      .from(pipelines)
      .where(and(eq(pipelines.companyId, input.companyId), eq(pipelines.key, definition.key)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (already) {
      existing.push(definition.key);
      continue;
    }

    const pipeline = await svc.createPipeline({
      companyId: input.companyId,
      key: definition.key,
      name: definition.name,
      description: definition.description,
      projectId: input.projectId ?? null,
      enforceTransitions: true,
      stages: definition.stages.map((stage, index) => ({
        key: stage.key,
        name: stage.name,
        kind: stage.kind,
        position: (index + 1) * 100,
        config: stage.config,
      })),
      actor,
    });

    // See the seam note above: version/ticketType land here, not in createPipeline.
    await db
      .update(pipelines)
      .set({ version: definition.version, ticketType: definition.ticketType })
      .where(and(eq(pipelines.companyId, input.companyId), eq(pipelines.id, pipeline.id)));

    const stageIdByKey = Object.fromEntries(pipeline.stages.map((s) => [s.key, s.id]));
    for (const edge of definition.transitions) {
      await svc.createTransition({
        companyId: input.companyId,
        pipelineId: pipeline.id,
        fromStageId: stageIdByKey[edge.from]!,
        toStageId: stageIdByKey[edge.to]!,
      });
    }

    seeded.push(definition.key);
  }

  return { seeded, existing };
}
