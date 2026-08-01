// @vitest-environment jsdom

/**
 * The registry is the POINT of this surface: adding a renderer for a new
 * artifact kind must require zero edits to FlowGatePayload or ArtifactBlock.
 * These tests prove that by registering a kind that does not exist in the
 * product ("fake-kind") and watching it render through the same path the real
 * ones use — and by proving an unclaimed kind still falls back to the file
 * list rather than to nothing.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalArtifact } from "../../api/approvals";
import {
  listArtifactRenderers,
  registerArtifactRenderer,
  resolveArtifactRenderer,
  unregisterArtifactRenderer,
} from "./index";

function artifact(over: Partial<ApprovalArtifact> = {}): ApprovalArtifact {
  return {
    available: true,
    degraded: false,
    repo: "sarala-ai/apex-design",
    headBranch: "design/APE-5",
    url: "https://github.com/sarala-ai/apex-design/pull/2",
    title: "APE-5",
    totals: { additions: 1, deletions: 0, changedFiles: 1 },
    files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
    files_truncated: false,
    acceptanceEvaluation: null,
    artifactKind: "code",
    ...over,
  } as ApprovalArtifact;
}

function renderNode(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<>{node}</>);
  });
  return container;
}

afterEach(() => {
  unregisterArtifactRenderer("fake-kind");
  document.body.innerHTML = "";
});

describe("artifact renderer registry", () => {
  it("renders a newly registered kind with no change to ArtifactBlock", () => {
    registerArtifactRenderer({
      kind: "fake-kind",
      match: () => true,
      render: (a) => <p data-testid="fake-kind-rendered">fake renderer saw {a.repo}</p>,
    });

    const renderer = resolveArtifactRenderer(
      artifact({ artifactKind: "fake-kind" as ApprovalArtifact["artifactKind"] }),
    );
    expect(renderer.kind).toBe("fake-kind");

    const container = renderNode(renderer.render(artifact({ repo: "acme/thing" })));
    expect(container.querySelector("[data-testid=fake-kind-rendered]")?.textContent).toContain(
      "acme/thing",
    );
  });

  it("falls back to the file list for a kind nobody registered", () => {
    const renderer = resolveArtifactRenderer(
      artifact({ artifactKind: "totally-unheard-of" as ApprovalArtifact["artifactKind"] }),
    );
    const container = renderNode(renderer.render(artifact()));
    expect(container.querySelector("[data-testid=artifact-file-list]")).not.toBeNull();
  });

  it("lets a renderer DECLINE an artifact it cannot usefully draw", () => {
    registerArtifactRenderer({
      kind: "fake-kind",
      match: () => false,
      render: () => <p data-testid="never">nope</p>,
    });
    const renderer = resolveArtifactRenderer(
      artifact({ artifactKind: "fake-kind" as ApprovalArtifact["artifactKind"] }),
    );
    const container = renderNode(renderer.render(artifact()));
    expect(container.querySelector("[data-testid=never]")).toBeNull();
    expect(container.querySelector("[data-testid=artifact-file-list]")).not.toBeNull();
  });

  it("replaces, rather than duplicates, a re-registered kind", () => {
    registerArtifactRenderer({ kind: "fake-kind", match: () => true, render: () => <i>one</i> });
    registerArtifactRenderer({ kind: "fake-kind", match: () => true, render: () => <i>two</i> });
    expect(listArtifactRenderers().filter((r) => r.kind === "fake-kind")).toHaveLength(1);
    const container = renderNode(
      resolveArtifactRenderer(
        artifact({ artifactKind: "fake-kind" as ApprovalArtifact["artifactKind"] }),
      ).render(artifact()),
    );
    expect(container.textContent).toContain("two");
  });

  it("routes a code artifact to the code renderer and a design artifact to the design renderer", () => {
    expect(resolveArtifactRenderer(artifact({ artifactKind: "code" })).kind).toBe("code");
    expect(
      resolveArtifactRenderer(
        artifact({
          artifactKind: "design",
          files: [{ path: "a.penpot", status: "modified", additions: 0, deletions: 0, binary: true }],
        }),
      ).kind,
    ).toBe("design");
  });

  it("declines the code renderer when there are no files at all", () => {
    expect(resolveArtifactRenderer(artifact({ artifactKind: "code", files: [] })).kind).toBe("unknown");
  });
});
