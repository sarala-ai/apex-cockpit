/**
 * Artifact KIND classification and RISK/REVERSIBILITY derivation.
 *
 * Both live server-side on purpose: the UI keys its artifact-renderer registry
 * off `artifactKind` and never re-derives it, and the reversibility line is
 * read off the flow definition's post-gate nodes rather than guessed at render
 * time. These tests pin the RULES, not the wording.
 */
import { describe, expect, it } from "vitest";
import {
  classifyArtifactKind,
  classifyPath,
  deriveRisk,
  nodeReversibility,
  type PrDiffSummary,
} from "../apex/flow/brief.js";
import type { FlowDefinition, FlowNode } from "../apex/flow/definition.js";

const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe("classifyPath", () => {
  it("recognises design documents by extension", () => {
    expect(classifyPath("boards/apex.penpot")).toBe("design");
    expect(classifyPath("Cover.fig")).toBe("design");
  });

  it("recognises code across languages and config formats", () => {
    expect(classifyPath("server/src/routes/approvals.ts")).toBe("code");
    expect(classifyPath("infra/main.tf")).toBe("code");
    expect(classifyPath("ci/build.yml")).toBe("code");
  });

  it("separates plans from prose docs by directory and by filename", () => {
    expect(classifyPath("specs/022-state/spec.md")).toBe("plan");
    expect(classifyPath("docs/plans/rollout.md")).toBe("plan");
    expect(classifyPath("notes/deploy-plan.md")).toBe("plan");
    expect(classifyPath("docs/architecture/work-loop.md")).toBe("doc");
    expect(classifyPath("README.md")).toBe("doc");
  });

  it("votes for nothing when the extension means nothing to us", () => {
    expect(classifyPath("assets/logo.bin")).toBeNull();
    expect(classifyPath("LICENSE")).toBeNull();
  });
});

describe("classifyArtifactKind", () => {
  it("returns unknown for an empty or unrecognised changeset", () => {
    expect(classifyArtifactKind([])).toBe("unknown");
    expect(classifyArtifactKind(files("a.bin", "b.unknownext"))).toBe("unknown");
  });

  it("lets a single design document win over everything around it", () => {
    // The .penpot IS the review. It is never outvoted by incidental files.
    expect(
      classifyArtifactKind(files("README.md", "src/a.ts", "src/b.ts", "boards/apex.penpot")),
    ).toBe("design");
  });

  it("gives the changeset to the kind holding the most files", () => {
    expect(classifyArtifactKind(files("src/a.ts", "src/b.ts", "README.md"))).toBe("code");
    expect(classifyArtifactKind(files("specs/a/spec.md", "specs/b/spec.md", "src/a.ts"))).toBe("plan");
    expect(classifyArtifactKind(files("docs/one.md", "docs/two.md", "src/a.ts"))).toBe("doc");
  });

  it("breaks ties toward the more consequential surface (code > plan > doc)", () => {
    expect(classifyArtifactKind(files("src/a.ts", "specs/x/spec.md"))).toBe("code");
    expect(classifyArtifactKind(files("specs/x/spec.md", "docs/y.md"))).toBe("plan");
  });
});

const gate: FlowNode = { id: "g", kind: "gate", gate: { mode: "approve" }, on_fail: "pause" } as FlowNode;
const workflowNode = (name: string): FlowNode =>
  ({ id: name, kind: "workflow", workflow: { workflow: name, params: {} }, on_fail: "pause" }) as FlowNode;

function flowOf(...nodes: FlowNode[]): FlowDefinition {
  return { name: "f", version: "1.0", description: "", ticket_type: "t", nodes } as FlowDefinition;
}

describe("nodeReversibility", () => {
  it("calls a merge reversible — a revert commit undoes it", () => {
    expect(nodeReversibility(workflowNode("design-pr-merge"))).toBe("reversible");
  });

  it("calls a deploy/release reversible only with effort — it goes live", () => {
    expect(nodeReversibility(workflowNode("cloud_run_deploy"))).toBe("reversible_with_effort");
    expect(nodeReversibility(workflowNode("apex_release"))).toBe("reversible_with_effort");
  });

  it("calls a destroy irreversible", () => {
    expect(nodeReversibility(workflowNode("destroy-vpc-stack"))).toBe("irreversible");
    expect(nodeReversibility(workflowNode("rotate-secrets-cloud-sql"))).toBe("irreversible");
  });

  it("refuses to guess an unrecognised workflow", () => {
    expect(nodeReversibility(workflowNode("frobnicate"))).toBe("unknown");
  });

  it("treats checks and further gates as harmless", () => {
    expect(nodeReversibility({ id: "c", kind: "check", check: { tool: "pytest", args: [], pass_criteria: "x" }, on_fail: "pause" } as FlowNode)).toBe("reversible");
    expect(nodeReversibility(gate)).toBe("reversible");
  });
});

const healthyArtifact = (over: Partial<Extract<PrDiffSummary, { degraded: false }>> = {}) =>
  ({
    available: true,
    degraded: false,
    repo: "sarala-ai/apex-design",
    headBranch: "design/APE-5",
    url: "https://github.com/x/y/pull/2",
    title: "t",
    totals: { additions: 0, deletions: 0, changedFiles: 1 },
    files: [{ path: "boards/apex.penpot", status: "modified", additions: 0, deletions: 0, binary: true }],
    files_truncated: false,
    acceptanceEvaluation: null,
    artifactKind: "design",
    ...over,
  }) as PrDiffSummary;

const verifiedOk = { headline: "ok", ok: true as boolean | null, machine: [] };

describe("deriveRisk", () => {
  it("takes the WORST reversibility across every post-gate node", () => {
    // A merge is reversible, but the destroy after it is not — the gate is
    // only as reversible as its least reversible consequence.
    const risk = deriveRisk({
      flow: flowOf(gate, workflowNode("design-pr-merge"), workflowNode("destroy-staging")),
      gateNodeId: "g",
      verified: verifiedOk,
      artifact: healthyArtifact(),
    });
    expect(risk.reversibility).toBe("irreversible");
    expect(risk.derived).toBe(true);
    expect(risk.risks.some((r) => r.includes("destroy-staging"))).toBe(true);
  });

  it("is reversible when the gate is the flow's last node", () => {
    const risk = deriveRisk({
      flow: flowOf(gate),
      gateNodeId: "g",
      verified: verifiedOk,
      artifact: healthyArtifact(),
    });
    expect(risk.reversibility).toBe("reversible");
    expect(risk.reversibilityLine).toMatch(/Reversible/);
  });

  it("names a deploy as the reason the change goes live", () => {
    const risk = deriveRisk({
      flow: flowOf(gate, workflowNode("cloud_run_deploy")),
      gateNodeId: "g",
      verified: verifiedOk,
      artifact: healthyArtifact({ artifactKind: "code" }),
    });
    expect(risk.reversibility).toBe("reversible_with_effort");
    expect(risk.risks.join(" ")).toContain("cloud_run_deploy");
  });

  it("degrades to unknown, not to optimism, when the flow cannot be read", () => {
    const risk = deriveRisk({
      flow: null,
      gateNodeId: "g",
      verified: verifiedOk,
      artifact: healthyArtifact(),
    });
    expect(risk.reversibility).toBe("unknown");
    expect(risk.derived).toBe(false);
  });

  it("degrades to unknown when the gate is not in the flow it names", () => {
    const risk = deriveRisk({
      flow: flowOf(workflowNode("a")),
      gateNodeId: "missing-gate",
      verified: verifiedOk,
      artifact: healthyArtifact(),
    });
    expect(risk.reversibility).toBe("unknown");
    expect(risk.derived).toBe(false);
  });

  it("raises a risk when the automatic check failed", () => {
    const risk = deriveRisk({
      flow: flowOf(gate, workflowNode("design-pr-merge")),
      gateNodeId: "g",
      verified: { headline: "no", ok: false, machine: [] },
      artifact: healthyArtifact(),
    });
    expect(risk.risks.join(" ")).toMatch(/did NOT pass/);
  });

  it("raises a risk when the artifact could not be loaded", () => {
    const risk = deriveRisk({
      flow: flowOf(gate),
      gateNodeId: "g",
      verified: verifiedOk,
      artifact: {
        available: true,
        degraded: true,
        repo: "r",
        headBranch: "b",
        error: "gh exploded",
        acceptanceEvaluation: null,
      },
    });
    expect(risk.risks.join(" ")).toContain("gh exploded");
  });

  it("says out loud that a binary design file has no line-level diff", () => {
    const risk = deriveRisk({
      flow: flowOf(gate, workflowNode("design-pr-merge")),
      gateNodeId: "g",
      verified: verifiedOk,
      artifact: healthyArtifact(),
    });
    expect(risk.risks.join(" ")).toMatch(/binary/);
  });

  it("flags a truncated file list", () => {
    const risk = deriveRisk({
      flow: flowOf(gate),
      gateNodeId: "g",
      verified: verifiedOk,
      artifact: healthyArtifact({ files_truncated: true }),
    });
    expect(risk.risks.join(" ")).toMatch(/truncated/);
  });
});
