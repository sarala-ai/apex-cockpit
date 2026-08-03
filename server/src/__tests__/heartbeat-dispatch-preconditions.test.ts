import { describe, expect, it } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import {
  DISPATCH_PRECONDITION_NO_CODEBASE_REASON,
  DISPATCH_PRECONDITION_NO_PERMISSION_DECISION_REASON,
  assertRunDispatchPreconditions,
  readDispatchPreconditionReason,
  type ResolvedWorkspaceForRun,
} from "../services/heartbeat.ts";

/**
 * The defect these tests pin: a task with `Project: None` was assigned to a
 * roster agent, commissioned immediately, and dispatched with no codebase. The
 * agent guessed, ran a recursive grep over the operator's home directory, and
 * the ticket sat `in_progress` with zero comments — the run left no trace.
 *
 * Every assertion below is on the EFFECTIVE outcome of a dispatch attempt (does
 * it launch, and if not what does the operator get told), never on a function
 * having been called.
 */

type PreconditionInput = Parameters<typeof assertRunDispatchPreconditions>[0];

function buildResolvedWorkspace(
  overrides: Partial<ResolvedWorkspaceForRun> = {},
): ResolvedWorkspaceForRun {
  return {
    cwd: "/Users/someone/.paperclip/agents/agent-1",
    source: "agent_home",
    projectId: null,
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    workspaceHints: [],
    warnings: [],
    ...overrides,
  };
}

function buildInput(overrides: Partial<PreconditionInput> = {}): PreconditionInput {
  return {
    agent: { id: "agent-1", name: "Implementer", adapterType: "claude_local" },
    issue: { id: "issue-1", identifier: "APEX-12", projectId: null },
    resolvedWorkspace: buildResolvedWorkspace(),
    effectiveAdapterConfig: { dangerouslySkipPermissions: false },
    ...overrides,
  };
}

/** A workspace that is genuinely usable: bound to a project with a repo. */
function boundWorkspace() {
  return buildResolvedWorkspace({
    cwd: "/Users/someone/code/cockpit",
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: "https://github.com/example/cockpit.git",
  });
}

describe("dispatch precondition: no codebase", () => {
  it("refuses an issue-bound run whose task has no project and no repo", () => {
    expect(() => assertRunDispatchPreconditions(buildInput())).toThrowError(
      /Implementer has no codebase: assign this task to a project with a repository, or set a repo on the project\./,
    );
  });

  it("names the agent, the task, and the directory it would have started in", () => {
    let thrown: unknown;
    try {
      assertRunDispatchPreconditions(buildInput());
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain("APEX-12");
    expect((thrown as Error).message).toContain("/Users/someone/.paperclip/agents/agent-1");
    expect(thrown).toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: DISPATCH_PRECONDITION_NO_CODEBASE_REASON,
          missingPrecondition: "codebase",
          agentName: "Implementer",
          issueIdentifier: "APEX-12",
          resolvedWorkspaceSource: "agent_home",
        },
      },
    });
  });

  it("refuses when a project is bound but nothing under it resolved a codebase", () => {
    // A project exists, yet the workspace still fell back to agent home: the
    // project carries no repo and no configured cwd, so the run has no code.
    expect(() =>
      assertRunDispatchPreconditions(
        buildInput({
          issue: { id: "issue-1", identifier: "APEX-12", projectId: "project-1" },
          resolvedWorkspace: buildResolvedWorkspace({ projectId: "project-1" }),
        }),
      ),
    ).toThrowError(/has no codebase/);
  });

  it("refuses a project that has no workspace row, despite the project_primary label", () => {
    // resolveWorkspaceForRun reports `project_primary` for a managed directory
    // it just created for a project with no project_workspaces row. The label
    // says project; the directory is empty.
    expect(() =>
      assertRunDispatchPreconditions(
        buildInput({
          issue: { id: "issue-1", identifier: "APEX-12", projectId: "project-1" },
          resolvedWorkspace: buildResolvedWorkspace({
            cwd: "/Users/someone/.paperclip/managed/project-1",
            source: "project_primary",
            projectId: "project-1",
            workspaceId: null,
          }),
        }),
      ),
    ).toThrowError(/has no codebase/);
  });

  it("refuses a project workspace whose configured cwd silently fell back to agent home", () => {
    // The fallback branch keeps source `project_primary` and the workspace id
    // while handing back the agent's own empty directory.
    expect(() =>
      assertRunDispatchPreconditions(
        buildInput({
          agent: { id: "agent-7", name: "Implementer", adapterType: "claude_local" },
          issue: { id: "issue-1", identifier: "APEX-12", projectId: "project-1" },
          resolvedWorkspace: buildResolvedWorkspace({
            cwd: resolveDefaultAgentWorkspaceDir("agent-7"),
            source: "project_primary",
            projectId: "project-1",
            workspaceId: "workspace-1",
          }),
        }),
      ),
    ).toThrowError(/has no codebase/);
  });

  it("allows a run bound to a project workspace with a repo", () => {
    expect(
      assertRunDispatchPreconditions(
        buildInput({
          issue: { id: "issue-1", identifier: "APEX-12", projectId: "project-1" },
          resolvedWorkspace: boundWorkspace(),
        }),
      ),
    ).toEqual({ dangerouslySkipPermissions: false });
  });

  it("allows a project-bound run with a local checkout and no remote repo url", () => {
    expect(
      assertRunDispatchPreconditions(
        buildInput({
          issue: { id: "issue-1", identifier: "APEX-12", projectId: "project-1" },
          resolvedWorkspace: buildResolvedWorkspace({
            cwd: "/Users/someone/code/cockpit",
            source: "project_primary",
            projectId: "project-1",
            workspaceId: "workspace-1",
          }),
        }),
      ),
    ).toEqual({ dangerouslySkipPermissions: false });
  });

  it("allows a continuation that resumed a prior session workspace", () => {
    expect(
      assertRunDispatchPreconditions(
        buildInput({
          resolvedWorkspace: buildResolvedWorkspace({
            cwd: "/Users/someone/code/cockpit",
            source: "task_session",
            repoUrl: "https://github.com/example/cockpit.git",
          }),
        }),
      ),
    ).toEqual({ dangerouslySkipPermissions: false });
  });

  it("does not refuse a run that has no ticket at all", () => {
    // There is nowhere to report a refusal, and a run with no issue is not the
    // "assigned a coding task with no code" shape this precondition exists for.
    expect(
      assertRunDispatchPreconditions(buildInput({ issue: null })),
    ).toEqual({ dangerouslySkipPermissions: false });
  });

  it("does not refuse an adapter that is not a git-sensitive local coding agent", () => {
    expect(
      assertRunDispatchPreconditions(
        buildInput({
          agent: { id: "agent-1", name: "Briefs Agent", adapterType: "http_webhook" },
        }),
      ),
    ).toEqual({ dangerouslySkipPermissions: false });
  });
});

describe("dispatch precondition: no permission decision", () => {
  it("refuses a claude_local run whose effective config states no decision", () => {
    let thrown: unknown;
    try {
      assertRunDispatchPreconditions(
        buildInput({
          issue: { id: "issue-1", identifier: "APEX-12", projectId: "project-1" },
          resolvedWorkspace: boundWorkspace(),
          effectiveAdapterConfig: { model: "opus" },
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toMatch(
      /Implementer has no permission decision: its effective run config does not set "dangerouslySkipPermissions"/,
    );
    expect((thrown as Error).message).toContain("APEX-12");
    expect(thrown).toMatchObject({
      code: "configuration_incomplete",
      resultJson: {
        configurationIncomplete: {
          reason: DISPATCH_PRECONDITION_NO_PERMISSION_DECISION_REASON,
          missingPrecondition: "permission_decision",
          adapterType: "claude_local",
        },
      },
    });
  });

  it("refuses a routine run with no ticket when the decision is absent", () => {
    // The routine scheduler is precisely the path that never consults
    // derivePermissionPolicy, so it must not be exempt.
    expect(() =>
      assertRunDispatchPreconditions(
        buildInput({ issue: null, effectiveAdapterConfig: {} }),
      ),
    ).toThrowError(/has no permission decision/);
  });

  it("refuses when the decision is present but not a boolean", () => {
    expect(() =>
      assertRunDispatchPreconditions(
        buildInput({
          issue: null,
          effectiveAdapterConfig: { dangerouslySkipPermissions: "false" },
        }),
      ),
    ).toThrowError(/has no permission decision/);
  });

  it("returns the governed decision so the launch config is built from it", () => {
    expect(
      assertRunDispatchPreconditions(
        buildInput({
          issue: null,
          effectiveAdapterConfig: {
            dangerouslySkipPermissions: false,
            allowedTools: "Read,Grep",
          },
        }),
      ),
    ).toEqual({ dangerouslySkipPermissions: false });
  });

  it("returns an explicit opt-in to bypass unchanged", () => {
    // Fail-closed means "no decision is refused", not "no run may bypass".
    // An operator who states the unsafe choice out loud still gets it.
    expect(
      assertRunDispatchPreconditions(
        buildInput({ issue: null, effectiveAdapterConfig: { dangerouslySkipPermissions: true } }),
      ),
    ).toEqual({ dangerouslySkipPermissions: true });
  });

  it("does not require a decision from an adapter with no bypass default", () => {
    expect(
      assertRunDispatchPreconditions(
        buildInput({
          agent: { id: "agent-1", name: "Coder", adapterType: "codex_local" },
          issue: { id: "issue-1", identifier: "APEX-12", projectId: "project-1" },
          resolvedWorkspace: boundWorkspace(),
          effectiveAdapterConfig: {},
        }),
      ),
    ).toEqual({ dangerouslySkipPermissions: false });
  });

  it("checks the codebase first, so a task with neither is told about the codebase", () => {
    // The missing codebase is the one the operator can act on immediately;
    // reporting the permission gap first would bury it.
    expect(() =>
      assertRunDispatchPreconditions(buildInput({ effectiveAdapterConfig: {} })),
    ).toThrowError(/has no codebase/);
  });
});

describe("readDispatchPreconditionReason", () => {
  it("recognises a refusal recorded on a failed run's resultJson", () => {
    expect(
      readDispatchPreconditionReason({
        resultJson: {
          configurationIncomplete: { reason: DISPATCH_PRECONDITION_NO_CODEBASE_REASON },
          stopReason: "error",
        },
      }),
    ).toBe(DISPATCH_PRECONDITION_NO_CODEBASE_REASON);
  });

  it("returns null for a configuration_incomplete run that failed on a secret binding", () => {
    expect(
      readDispatchPreconditionReason({
        resultJson: { configurationIncomplete: { reason: "secret_binding_missing" } },
      }),
    ).toBeNull();
  });

  it("returns null for a run with no result payload", () => {
    expect(readDispatchPreconditionReason(null)).toBeNull();
    expect(readDispatchPreconditionReason({ resultJson: null })).toBeNull();
  });
});
