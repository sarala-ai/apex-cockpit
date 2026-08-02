/**
 * The step executor — one place where a step of each of the THREE kinds is
 * EXECUTED (docs/architecture/process-definition.md §2a).
 *
 * | Kind    | Who executes it                                  | Cost      |
 * |---------|--------------------------------------------------|-----------|
 * | `run`   | the machine, deterministically                   | nothing   |
 * | `agent` | a model, bounded by a permission profile         | tokens    |
 * | `gate`  | a person                                         | attention |
 *
 * The kinds are distinguished by WHO EXECUTES, which is the only axis that
 * changes cost, accountability and blast radius. An earlier draft had four,
 * splitting `workflow` from `check` — but read their configs side by side and
 * they are one step with two spellings of *what to run*. A check is a run
 * whose failure HOLDS rather than ROUTES, and that is `on_fail` configuration,
 * not identity. Carrying both taught authors to ask "is this a workflow or a
 * check?", a question with no principled answer.
 *
 * A `run` step's TARGET is pluggable (`workflow` | `command`) — see
 * runner.ts. That is the extension point, and it is why no kind is called
 * `workflow` any more: a workflow is what a step TARGETS, not what it IS.
 *
 * **The keystone constraint.** A `run` is executed here by `runner.ts` shelling
 * the apex CLI, and `acceptance` is evaluated here by `agent-step.ts`'s
 * `evaluateAcceptanceV1` (fs.stat, or a read-path CLI call for `pr_exists`).
 * No path in this module reaches a language model, an adapter, a heartbeat run
 * or a routine for a `run` or for acceptance — the `agent` PORT is the only
 * door to a model, and neither of those ever opens it. The moment a
 * deterministic step needs a model to attest that it succeeded, the platform's
 * central claim is gone.
 *
 * **This is a move, not a rewrite.** The bodies below are the flow
 * coordinator's `runLoop` switch, `executeAgentNode` and `executeGateNode`,
 * carried across with their ordering, their classifications and their
 * failure vocabulary intact. What changed is only WHO owns the state: the
 * coordinator used to interleave its own `transition()` calls between the
 * effects; those calls are now PORTS the host supplies, called at exactly the
 * same points in exactly the same order. A host that implements the ports with
 * its own state machine gets the flow coordinator's behaviour; that is what
 * lets a pipeline case run the same step kinds without a second executor.
 *
 * Two things deliberately stay with the HOST, because they are state-machine
 * decisions rather than step execution:
 *   - `on_fail` ROUTING (pause / skip / jump). The executor parses it
 *     (`parseOnFail`, so both hosts route identically) and classifies the
 *     failure; moving the pointer is the host's single-writer business.
 *   - advancement and completion. Same reason.
 */
import type { StepTargetRunner } from "./runner.js";
import {
  buildAgentInstructionComment,
  evaluateAcceptanceV1,
  type AcceptanceEvaluation,
  type ChangeRequestRound,
} from "./agent-step.js";

export const STEP_KINDS = ["run", "agent", "gate"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** The routing grammar. Unchanged by the three-kind collapse on purpose: a
 *  step's failure route is orthogonal to who executed it. */
export const STEP_ON_FAIL_RE = /^(pause|skip|jump:[A-Za-z0-9_-]+)$/;

export type OnFailRoute =
  | { kind: "pause" }
  | { kind: "skip" }
  | { kind: "jump"; target: string };

/** Parse a step's `on_fail` into a route. Anything unrecognised (including
 *  null/undefined) is `pause` — the conservative default core also uses:
 *  an unreadable routing instruction must never silently advance work. */
export function parseOnFail(raw: string | null | undefined): OnFailRoute {
  const value = (raw ?? "pause").trim();
  if (value === "skip") return { kind: "skip" };
  if (value.startsWith("jump:")) {
    const target = value.slice("jump:".length).trim();
    if (target) return { kind: "jump", target };
    return { kind: "pause" };
  }
  return { kind: "pause" };
}

/** A classified step failure — the shape every kind fails with. */
export type StepFailure = { errorType: string; message: string };

/** What a `run` step runs. The union IS the extension point: a third target
 *  type is one case here and one method on `StepTargetRunner`, never a fourth
 *  step kind. */
export type RunTarget =
  | { type: "workflow"; workflow: string; params?: Record<string, unknown> }
  | { type: "command"; tool: string; args?: string[] };

export type RunStepConfig = { target: RunTarget };
export type AgentStepConfig = {
  prompt_template: string;
  acceptance: string;
  budget?: Record<string, unknown> | null;
};
export type GateStepConfig = {
  mode: "approve" | "notify";
  prompt?: string | null;
  requires?: string[] | null;
};

/** `{kind, config, acceptance?, permissions?, onFail}` — the executor's whole
 *  input surface. `key` is the step's identity in its definition (a flow node
 *  id or a stage key: docs/architecture/execution-substrate.md §6.1 — the same
 *  kind of thing). */
export type StepSpec =
  | { kind: "run"; key: string; onFail?: string | null; config: RunStepConfig }
  | {
      kind: "agent";
      key: string;
      onFail?: string | null;
      config: AgentStepConfig;
      /** Overrides `config.acceptance` when present (already-rendered hosts). */
      acceptance?: string | null;
      permissions?: unknown;
    }
  | { kind: "gate"; key: string; onFail?: string | null; config: GateStepConfig };

export type StepOutcome =
  /** The step is done and the host may advance. */
  | { status: "succeeded"; detail: Record<string, unknown> }
  /** The step failed; the host applies `parseOnFail(spec.onFail)`. */
  | { status: "failed"; failure: StepFailure }
  /** The step is in flight and the case is parked; nothing further to do now. */
  | { status: "waiting"; wait: "agent" | "gate"; detail: Record<string, unknown> };

/** Effects an `agent` step needs from its host. Every method is called at the
 *  same point in the sequence the flow coordinator called its own equivalent. */
export interface AgentStepPort {
  /** The flow's own executor, the issue's assignee, or the company's single
   *  assignable agent — a classified failure, never a guess. */
  resolveExecutorAgent(): Promise<
    { ok: true; agentId: string; assigned: boolean } | { ok: false; failure: StepFailure }
  >;
  /** Rework rounds still binding on this step, newest last. */
  readChangeRequestRounds(stepKey: string): Promise<ChangeRequestRound[]>;
  /** Render the acceptance template in the host's vocabulary. Separate from
   *  `renderPrompt` because the prompt's own `{{acceptance}}` token must
   *  resolve to the ALREADY-RENDERED acceptance — the agent and the
   *  server-side evaluator must read one identical concrete string. */
  renderAcceptance(template: string): string;
  renderPrompt(template: string, acceptance: string): string;
  /** Park the case (single-writer compare-and-set out of `running`) BEFORE the
   *  instruction is posted — so a crash mid-commission leaves a parked case,
   *  never a running one with an orphan run. */
  park(input: {
    stepKey: string;
    agentId: string;
    agentAutoAssigned: boolean;
    acceptance: string;
    budget: Record<string, unknown> | null;
    changeRequestRound: number | null;
  }): Promise<void>;
  /** Post the instruction; its id is the run's wake comment. */
  postInstruction(body: string): Promise<string>;
  /** Commission the bounded run. `null` = the machinery deferred or declined. */
  commission(input: {
    agentId: string;
    instructionCommentId: string;
    renderedPrompt: string;
    permissions: unknown;
  }): Promise<{ runId: string } | null>;
  recordCommissioned(input: {
    stepKey: string;
    runId: string;
    agentId: string;
    instructionCommentId: string;
  }): Promise<void>;
  recordDeferred(input: { stepKey: string; agentId: string; instructionCommentId: string }): Promise<void>;
  /** Definition name, for the instruction comment's header. */
  definitionName(): string;
}

/** Effects a `gate` step needs from its host. */
export interface GateStepPort {
  /** `notify` mode: say so and auto-proceed (reversible, per work-loop doctrine). */
  notify(input: { stepKey: string; prompt: string | null }): Promise<void>;
  /** `approve` mode: create the decision the human makes, then park. */
  openApproval(input: {
    stepKey: string;
    prompt: string | null;
    requires: string[] | null;
  }): Promise<{ approvalId: string }>;
}

export interface StepExecutorPorts {
  /** The `run` kind's hands. Zero tokens by construction — see runner.ts. */
  runner: StepTargetRunner;
  /** Template interpolation in the host's own vocabulary. Identity by default. */
  render?: (template: string) => string;
  /** Server-evaluated acceptance. Injectable so tests never shell the CLI. */
  evaluateAcceptance?: (acceptance: string) => Promise<AcceptanceEvaluation>;
  agent?: AgentStepPort;
  gate?: GateStepPort;
  /** Errors the executor must NOT swallow into a classified failure — a host
   *  state conflict is the host's to handle, not this step's to route. */
  isFatal?: (err: unknown) => boolean;
}

function renderParams(
  params: Record<string, unknown>,
  render: (template: string) => string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, typeof value === "string" ? render(value) : value]),
  );
}

/** Interpolate `{{name}}` tokens against a flat variable map. Unknown tokens
 *  are left verbatim — never silently dropped. */
export function renderTemplate(
  template: string,
  variables: Record<string, string | number | boolean>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (token, key: string) =>
    key in variables ? String(variables[key]) : token,
  );
}

export function stepExecutor(ports: StepExecutorPorts) {
  const render = ports.render ?? ((template: string) => template);
  const evaluateAcceptance = ports.evaluateAcceptance ?? ((acceptance: string) => evaluateAcceptanceV1(acceptance));
  const isFatal = ports.isFatal ?? (() => false);

  /** RUN — the machine executes it, deterministically, and it costs NOTHING.
   *  What it runs is the target's business; how a failure routes is the host's
   *  (`on_fail`, default `pause`, which is what "hold the step" means). */
  async function executeRun(spec: Extract<StepSpec, { kind: "run" }>): Promise<StepOutcome> {
    const target = spec.config.target;
    const result =
      target.type === "workflow"
        ? await ports.runner.runWorkflow({
            workflow: target.workflow,
            params: renderParams(target.params ?? {}, render),
          })
        : await ports.runner.runCommand({
            tool: target.tool,
            args: (target.args ?? []).map((arg) => render(arg)),
          });
    return result.ok
      ? {
          status: "succeeded",
          detail: {
            kind: "run",
            target: target.type,
            ...(target.type === "workflow" ? { workflow: target.workflow } : { tool: target.tool }),
            ...result.detail,
          },
        }
      : { status: "failed", failure: { errorType: result.errorType, message: result.message } };
  }

  /** A — one bounded agent run, commissioned through the host's own execution
   *  machinery. The ONLY kind that spends tokens. */
  async function executeAgent(spec: Extract<StepSpec, { kind: "agent" }>): Promise<StepOutcome> {
    const port = ports.agent;
    if (!port) {
      return {
        status: "failed",
        failure: {
          errorType: "agent_port_unavailable",
          message: `step '${spec.key}' is an agent step but this host supplies no agent port`,
        },
      };
    }
    const executor = await port.resolveExecutorAgent();
    if (!executor.ok) return { status: "failed", failure: executor.failure };

    const acceptance = port.renderAcceptance(spec.acceptance ?? spec.config.acceptance);
    const renderedPrompt = port.renderPrompt(spec.config.prompt_template, acceptance);
    // Rework feedback rides the SAME channel the instruction already uses.
    const changeRequestRounds = await port.readChangeRequestRounds(spec.key);
    const budget = spec.config.budget ?? null;
    await port.park({
      stepKey: spec.key,
      agentId: executor.agentId,
      agentAutoAssigned: executor.assigned,
      acceptance,
      budget,
      changeRequestRound:
        changeRequestRounds.length > 0 ? Math.max(...changeRequestRounds.map((round) => round.round)) : null,
    });

    // The instruction comment IS the run's wake comment — a run without its
    // instruction is not this step's run, so its failure is fatal to the step.
    let instructionCommentId: string;
    try {
      instructionCommentId = await port.postInstruction(
        buildAgentInstructionComment({
          flowName: port.definitionName(),
          nodeId: spec.key,
          renderedPrompt,
          acceptance,
          budget,
          changeRequestRounds,
        }),
      );
    } catch (err) {
      if (isFatal(err)) throw err;
      return {
        status: "failed",
        failure: {
          errorType: "agent_instruction_comment_failed",
          message: `could not post the agent step's instruction comment: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      };
    }

    try {
      const commissioned = await port.commission({
        agentId: executor.agentId,
        instructionCommentId,
        renderedPrompt,
        permissions: spec.permissions,
      });
      if (!commissioned) {
        // Deferred/skipped wakeup. Deferral is the common real case: the host
        // already has an active run holding the execution lock and will
        // PROMOTE the deferred wake when it finishes. Surfaced + classified,
        // never silent, never a premature pause that strands the promoted run.
        await port.recordDeferred({
          stepKey: spec.key,
          agentId: executor.agentId,
          instructionCommentId,
        });
        return { status: "waiting", wait: "agent", detail: { deferred: true, instructionCommentId } };
      }
      await port.recordCommissioned({
        stepKey: spec.key,
        runId: commissioned.runId,
        agentId: executor.agentId,
        instructionCommentId,
      });
      return {
        status: "waiting",
        wait: "agent",
        detail: { runId: commissioned.runId, instructionCommentId },
      };
    } catch (err) {
      if (isFatal(err)) throw err;
      return {
        status: "failed",
        failure: {
          errorType:
            err instanceof Error && "errorType" in err && typeof (err as { errorType?: unknown }).errorType === "string"
              ? (err as { errorType: string }).errorType
              : "agent_run_commission_failed",
          message: `commissioning the bounded agent run failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  /** G — a human decision. `notify` auto-proceeds; `approve` parks. */
  async function executeGate(spec: Extract<StepSpec, { kind: "gate" }>): Promise<StepOutcome> {
    const port = ports.gate;
    if (!port) {
      return {
        status: "failed",
        failure: {
          errorType: "gate_port_unavailable",
          message: `step '${spec.key}' is a gate step but this host supplies no gate port`,
        },
      };
    }
    const prompt = spec.config.prompt ?? null;
    if (spec.config.mode === "notify") {
      await port.notify({ stepKey: spec.key, prompt });
      return { status: "succeeded", detail: { kind: "gate", mode: "notify", prompt } };
    }
    const { approvalId } = await port.openApproval({
      stepKey: spec.key,
      prompt,
      requires: spec.config.requires ?? null,
    });
    return { status: "waiting", wait: "gate", detail: { approvalId, prompt } };
  }

  return {
    /** Execute one step. Never routes on failure — that is the host's. */
    async execute(spec: StepSpec): Promise<StepOutcome> {
      switch (spec.kind) {
        case "run":
          return executeRun(spec);
        case "agent":
          return executeAgent(spec);
        case "gate":
          return executeGate(spec);
      }
    },

    /**
     * Server-evaluated acceptance — the keystone. Evaluated HERE, by the
     * server, against the v1 grammar (`file_exists:<path>`,
     * `pr_exists:<repo>#<head>`, otherwise recorded verbatim and treated as
     * unverified-but-passing). No agent is asked whether it succeeded.
     *
     * Takes an ALREADY-RENDERED criteria string: the host owns interpolation
     * (see `AgentStepPort.renderAcceptance`) so the evaluator and whoever was
     * told the criteria always read the same concrete string.
     */
    async evaluateAcceptance(acceptance: string): Promise<AcceptanceEvaluation> {
      return evaluateAcceptance(acceptance);
    },

    parseOnFail,
  };
}

export type StepExecutor = ReturnType<typeof stepExecutor>;
