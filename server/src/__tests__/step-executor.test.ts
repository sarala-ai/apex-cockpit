import { describe, expect, it } from "vitest";
import {
  parseOnFail,
  renderTemplate,
  stepExecutor,
  type AgentStepPort,
  type GateStepPort,
} from "../apex/steps/step-executor.ts";
import type { StepTargetRunner, NodeExecutionResult } from "../apex/steps/runner.ts";

function runnerStub(
  overrides: Partial<StepTargetRunner> = {},
  calls: string[] = [],
): StepTargetRunner & { calls: string[] } {
  const ok: NodeExecutionResult = { ok: true, detail: { status: "success" } };
  return {
    calls,
    runWorkflow: async (config) => {
      calls.push(`workflow:${config.workflow}:${JSON.stringify(config.params)}`);
      return ok;
    },
    runCommand: async (config) => {
      calls.push(`command:${config.tool}`);
      return ok;
    },
    ...overrides,
  } as StepTargetRunner & { calls: string[] };
}

/** A port that fails the test if any agent/gate door is opened. The zero-token
 *  claim is only worth stating if something enforces it. */
function forbiddenAgentPort(): AgentStepPort {
  const boom = (what: string) => () => {
    throw new Error(`zero-token violation: a deterministic step reached ${what}`);
  };
  return {
    definitionName: boom("definitionName") as never,
    resolveExecutorAgent: boom("resolveExecutorAgent") as never,
    renderAcceptance: boom("renderAcceptance") as never,
    renderPrompt: boom("renderPrompt") as never,
    readChangeRequestRounds: boom("readChangeRequestRounds") as never,
    park: boom("park") as never,
    postInstruction: boom("postInstruction") as never,
    commission: boom("commission") as never,
    recordCommissioned: boom("recordCommissioned") as never,
    recordDeferred: boom("recordDeferred") as never,
  };
}

describe("parseOnFail", () => {
  it("reads the three routes and defaults everything else to pause", () => {
    expect(parseOnFail("skip")).toEqual({ kind: "skip" });
    expect(parseOnFail("jump:build")).toEqual({ kind: "jump", target: "build" });
    expect(parseOnFail("pause")).toEqual({ kind: "pause" });
    expect(parseOnFail(undefined)).toEqual({ kind: "pause" });
    expect(parseOnFail("jump:")).toEqual({ kind: "pause" });
    expect(parseOnFail("nonsense")).toEqual({ kind: "pause" });
  });
});

describe("renderTemplate", () => {
  it("interpolates known tokens and leaves unknown ones verbatim", () => {
    expect(renderTemplate("head: design/{{case_key}} v{{missing}}", { case_key: "APE-7" })).toBe(
      "head: design/APE-7 v{{missing}}",
    );
  });
});

describe("stepExecutor — a run step costs nothing, whichever target it has", () => {
  it("runs a workflow step through the runner alone, with no agent port in play", async () => {
    const runner = runnerStub();
    const outcome = await stepExecutor({
      runner,
      agent: forbiddenAgentPort(),
      render: (template) => renderTemplate(template, { identifier: "APE-7" }),
    }).execute({
      kind: "run",
      key: "publish",
      config: {
        target: { type: "workflow", workflow: "open-pr", params: { head: "design/{{identifier}}", draft: true } },
      },
    });

    expect(outcome).toEqual({
      status: "succeeded",
      detail: { kind: "run", target: "workflow", workflow: "open-pr", status: "success" },
    });
    expect(runner.calls).toEqual(['workflow:open-pr:{"head":"design/APE-7","draft":true}']);
  });

  it("runs a command target through the same runner, and still opens no agent door", async () => {
    const runner = runnerStub();
    const outcome = await stepExecutor({ runner, agent: forbiddenAgentPort() }).execute({
      kind: "run",
      key: "verify",
      config: { target: { type: "command", tool: "health generate_health_report", args: [] } },
    });

    expect(outcome.status).toBe("succeeded");
    expect(runner.calls).toEqual(["command:health generate_health_report"]);
  });

  it("classifies a failing deterministic step instead of routing it", async () => {
    const runner = runnerStub({
      runWorkflow: async () => ({ ok: false, errorType: "workflow_failed", message: "step 2 failed" }),
    });
    const outcome = await stepExecutor({ runner }).execute({
      kind: "run",
      key: "publish",
      onFail: "jump:build",
      config: { target: { type: "workflow", workflow: "open-pr" } },
    });

    expect(outcome).toEqual({
      status: "failed",
      failure: { errorType: "workflow_failed", message: "step 2 failed" },
    });
    // Routing stays with the host — the executor only classifies.
    expect(parseOnFail("jump:build")).toEqual({ kind: "jump", target: "build" });
  });

  it("evaluates acceptance on the server, never by asking an agent", async () => {
    const runner = runnerStub();
    const executor = stepExecutor({
      runner,
      agent: forbiddenAgentPort(),
      evaluateAcceptance: async (criteria) =>
        criteria === "file_exists:/nope"
          ? { ok: false, evaluation: "checked", message: "missing" }
          : { ok: true, evaluation: "checked" },
    });

    await expect(executor.evaluateAcceptance("file_exists:/nope")).resolves.toMatchObject({ ok: false });
    await expect(executor.evaluateAcceptance("file_exists:/yes")).resolves.toMatchObject({ ok: true });
    expect(runner.calls).toEqual([]);
  });
});

describe("stepExecutor — agent", () => {
  function agentPort(overrides: Partial<AgentStepPort> = {}) {
    const calls: string[] = [];
    const port: AgentStepPort = {
      definitionName: () => "feature",
      resolveExecutorAgent: async () => {
        calls.push("resolve");
        return { ok: true, agentId: "agent-1", assigned: false };
      },
      renderAcceptance: (template) => template.replace("{{identifier}}", "APE-7"),
      renderPrompt: (template, acceptance) => `${template}|${acceptance}`,
      readChangeRequestRounds: async () => {
        calls.push("rounds");
        return [];
      },
      park: async () => {
        calls.push("park");
      },
      postInstruction: async () => {
        calls.push("instruction");
        return "comment-1";
      },
      commission: async () => {
        calls.push("commission");
        return { runId: "run-1" };
      },
      recordCommissioned: async () => {
        calls.push("commissioned");
      },
      recordDeferred: async () => {
        calls.push("deferred");
      },
      ...overrides,
    };
    return { port, calls };
  }

  const spec = {
    kind: "agent" as const,
    key: "author",
    config: { prompt_template: "do the thing", acceptance: "pr_exists:o/r#design/{{identifier}}", budget: null },
  };

  it("parks, instructs, commissions — in that order — and waits", async () => {
    const { port, calls } = agentPort();
    const outcome = await stepExecutor({ runner: runnerStub(), agent: port }).execute(spec);

    expect(outcome).toEqual({
      status: "waiting",
      wait: "agent",
      detail: { runId: "run-1", instructionCommentId: "comment-1" },
    });
    expect(calls).toEqual(["resolve", "rounds", "park", "instruction", "commission", "commissioned"]);
  });

  it("records a deferral rather than pausing when the machinery declines", async () => {
    const { port, calls } = agentPort({ commission: async () => null });
    const outcome = await stepExecutor({ runner: runnerStub(), agent: port }).execute(spec);

    expect(outcome).toMatchObject({ status: "waiting", wait: "agent", detail: { deferred: true } });
    expect(calls).toContain("deferred");
  });

  it("classifies a failed commission but re-throws host-fatal errors", async () => {
    class Conflict extends Error {}
    const { port } = agentPort({
      commission: async () => {
        throw new Error("wakeup exploded");
      },
    });
    const outcome = await stepExecutor({ runner: runnerStub(), agent: port }).execute(spec);
    expect(outcome).toMatchObject({ status: "failed", failure: { errorType: "agent_run_commission_failed" } });

    const fatal = agentPort({
      commission: async () => {
        throw new Conflict("state moved");
      },
    });
    await expect(
      stepExecutor({
        runner: runnerStub(),
        agent: fatal.port,
        isFatal: (err) => err instanceof Conflict,
      }).execute(spec),
    ).rejects.toThrow("state moved");
  });

  it("fails classified when the host supplies no agent port", async () => {
    const outcome = await stepExecutor({ runner: runnerStub() }).execute(spec);
    expect(outcome).toMatchObject({ status: "failed", failure: { errorType: "agent_port_unavailable" } });
  });
});

describe("stepExecutor — gate", () => {
  it("auto-proceeds a notify gate and parks an approve gate", async () => {
    const calls: string[] = [];
    const port: GateStepPort = {
      notify: async ({ stepKey }) => {
        calls.push(`notify:${stepKey}`);
      },
      openApproval: async ({ stepKey }) => {
        calls.push(`approval:${stepKey}`);
        return { approvalId: "approval-1" };
      },
    };
    const executor = stepExecutor({ runner: runnerStub(), gate: port });

    await expect(
      executor.execute({ kind: "gate", key: "notice", config: { mode: "notify", prompt: "fyi" } }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      executor.execute({ kind: "gate", key: "promote", config: { mode: "approve", prompt: "ship?" } }),
    ).resolves.toEqual({
      status: "waiting",
      wait: "gate",
      detail: { approvalId: "approval-1", prompt: "ship?" },
    });
    expect(calls).toEqual(["notify:notice", "approval:promote"]);
  });
});
