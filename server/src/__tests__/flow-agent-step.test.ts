import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptanceArtifactPath,
  buildAgentInstructionComment,
  evaluateAcceptanceV1,
  renderAgentPrompt,
} from "../apex/flow/agent-step.js";

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
