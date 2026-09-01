import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptanceArtifactPath,
  acceptancePullRequestTarget,
  acceptanceScanKind,
  buildAgentInstructionComment,
  evaluateAcceptanceV1,
  isMachineEvaluableAcceptance,
  renderAgentPrompt,
  renderWorkflowParams,
} from "../apex/steps/agent-step.js";

const context = {
  identifier: "APE-42",
  title: "Fix the widget",
  description: "It wobbles",
  issueId: "11111111-1111-1111-1111-111111111111",
  flowName: "bug",
  nodeId: "repro_fix",
  acceptance: "tests pass",
};

describe("renderAgentPrompt", () => {
  it("interpolates known {{placeholders}}", () => {
    const out = renderAgentPrompt(
      "Work {{identifier}} — {{title}}.\n{{description}}\nAccept: {{acceptance}} ({{flow_name}}/{{node_id}})",
      context,
    );
    expect(out).toBe("Work APE-42 — Fix the widget.\nIt wobbles\nAccept: tests pass (bug/repro_fix)");
  });

  it("leaves unknown placeholders verbatim and falls back identifier->issueId", () => {
    const out = renderAgentPrompt("{{identifier}} {{mystery_token}}", { ...context, identifier: null });
    expect(out).toBe(`${context.issueId} {{mystery_token}}`);
  });
});

describe("acceptance v1", () => {
  let dir!: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-step-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("non-file acceptance strings evaluate as run-success-only", async () => {
    const result = await evaluateAcceptanceV1("a failing test now passes");
    expect(result.ok).toBe(true);
    expect(result.evaluation).toContain("run success only");
    expect(acceptanceArtifactPath("a failing test now passes")).toBeNull();
  });

  it("file_exists verifies presence and classifies absence", async () => {
    const artifact = join(dir, "out.txt");
    const missing = await evaluateAcceptanceV1(`file_exists:${artifact}`);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain(artifact);

    await writeFile(artifact, "x");
    const present = await evaluateAcceptanceV1(`file_exists:${artifact}`);
    expect(present.ok).toBe(true);
    expect(present.evaluation).toContain("file_exists verified");
  });

  it("relative paths resolve against the launch dir", () => {
    expect(acceptanceArtifactPath("file_exists: rel/out.txt", "/launch")).toBe("/launch/rel/out.txt");
    expect(acceptanceArtifactPath("file_exists:/abs/out.txt", "/launch")).toBe("/abs/out.txt");
  });
});

describe("acceptance v1 — pr_exists", () => {
  it("parses pr_exists:<repo>#<head> and ignores non-matching strings", () => {
    expect(acceptancePullRequestTarget("pr_exists:sarala-ai/apex-design#design/APE-7")).toEqual({
      repo: "sarala-ai/apex-design",
      head: "design/APE-7",
    });
    expect(acceptancePullRequestTarget("pr_exists:no-hash-here")).toBeNull();
    expect(acceptancePullRequestTarget("file_exists:/x")).toBeNull();
    expect(acceptancePullRequestTarget("a PR exists")).toBeNull();
  });

  it("passes when the injected check finds the PR and records its URL", async () => {
    const calls: Array<[string, string]> = [];
    const result = await evaluateAcceptanceV1("pr_exists:sarala-ai/apex-design#design/APE-7", {
      checkPullRequest: async (repo, head) => {
        calls.push([repo, head]);
        return { exists: true, url: "https://github.com/sarala-ai/apex-design/pull/3", number: 3 };
      },
    });
    expect(calls).toEqual([["sarala-ai/apex-design", "design/APE-7"]]);
    expect(result.ok).toBe(true);
    expect(result.evaluation).toContain("pr_exists verified");
    expect(result.evaluation).toContain("https://github.com/sarala-ai/apex-design/pull/3");
  });

  it("fails classified when no open PR exists for the head branch", async () => {
    const result = await evaluateAcceptanceV1("pr_exists:sarala-ai/apex-design#design/APE-7", {
      checkPullRequest: async () => ({
        exists: false,
        message: "No open pull request on sarala-ai/apex-design with head branch 'design/APE-7'",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("acceptance pull request not found");
      expect(result.message).toContain("design/APE-7");
    }
  });
});

describe("acceptance v1 — scan_clean", () => {
  it("parses a closed set of scan kinds and rejects anything else", () => {
    expect(acceptanceScanKind("scan_clean:secrets")).toBe("secrets");
    expect(acceptanceScanKind("scan_clean: iac")).toBe("iac");
    // A free-text kind would produce a contract nobody can evaluate. Refusing
    // it here means the typo surfaces at authoring time, where a person can
    // fix it, rather than at runtime where nobody is watching.
    expect(acceptanceScanKind("scan_clean:sekrets")).toBeNull();
    expect(acceptanceScanKind("scan_clean:")).toBeNull();
    expect(acceptanceScanKind("the scan is clean")).toBeNull();
  });

  it("is machine-evaluable, so a stage may gate on it", () => {
    expect(isMachineEvaluableAcceptance("scan_clean:secrets")).toBe(true);
    expect(isMachineEvaluableAcceptance("scan_clean:sekrets")).toBe(false);
    expect(isMachineEvaluableAcceptance("no secrets are committed")).toBe(false);
  });

  it("passes when the scan comes back clean, and records what was scanned", async () => {
    const calls: string[] = [];
    const result = await evaluateAcceptanceV1("scan_clean:secrets", {
      checkScan: async (kind) => {
        calls.push(kind);
        return { clean: true, scanMode: "commit_range" };
      },
    });
    expect(calls).toEqual(["secrets"]);
    expect(result.ok).toBe(true);
    expect(result.evaluation).toContain("scan_clean verified");
    // "clean" means nothing without knowing what was looked at.
    expect(result.evaluation).toContain("commit_range");
  });

  it("fails classified when the scan finds something", async () => {
    const result = await evaluateAcceptanceV1("scan_clean:secrets", {
      checkScan: async () => ({ clean: false, message: "3 secrets finding(s)." }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("acceptance security scan not clean");
  });

  it("fails — not passes — when the scan could not run at all", async () => {
    // The whole point of the subsystem: a scanner that is missing, timed out
    // or crashed leaves the contract UNCHECKED, and unchecked is not clean.
    const result = await evaluateAcceptanceV1("scan_clean:secrets", {
      checkScan: async () => ({
        clean: false,
        message: "the secrets scan did not complete, so this contract was NOT checked",
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("NOT checked");
  });
});

describe("renderWorkflowParams", () => {
  it("interpolates string values and passes non-strings through", () => {
    const out = renderWorkflowParams(
      { repo: "sarala-ai/apex-design", head: "design/{{identifier}}", retries: 2, flag: true },
      context,
    );
    expect(out).toEqual({
      repo: "sarala-ai/apex-design",
      head: "design/APE-42",
      retries: 2,
      flag: true,
    });
  });
});

describe("buildAgentInstructionComment", () => {
  it("carries prompt, acceptance, and advisory budget", () => {
    const body = buildAgentInstructionComment({
      flowName: "bug",
      nodeId: "repro_fix",
      renderedPrompt: "Do the thing",
      acceptance: "tests pass",
      budget: { max_turns: 30 },
    });
    expect(body).toContain("Do the thing");
    expect(body).toContain("Acceptance: tests pass");
    expect(body).toContain("advisory in v1");
    expect(body).toContain("max_turns");
  });
});
