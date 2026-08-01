// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalArtifact, ApprovalPrDiffFile } from "../../api/approvals";
import { DesignArtifact, isDesignFile } from "./DesignRenderer";

function render(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(<>{node}</>);
  });
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

const penpot = (over: Partial<ApprovalPrDiffFile> = {}): ApprovalPrDiffFile => ({
  path: "product/apex-platform.penpot",
  status: "modified",
  additions: 0,
  deletions: 0,
  binary: true,
  patch: null,
  ...over,
});

const artifactWith = (files: ApprovalPrDiffFile[]): ApprovalArtifact =>
  ({
    available: true,
    degraded: false,
    repo: "sarala-ai/apex-design",
    headBranch: "design/APE-5",
    url: "https://github.com/sarala-ai/apex-design/pull/2",
    title: "APE-5",
    totals: { additions: 0, deletions: 0, changedFiles: files.length },
    files,
    files_truncated: false,
    acceptanceEvaluation: null,
    artifactKind: "design",
  }) as ApprovalArtifact;

describe("isDesignFile", () => {
  it("recognises the design formats and nothing else", () => {
    expect(isDesignFile(penpot())).toBe(true);
    expect(isDesignFile(penpot({ path: "Cover.FIG" }))).toBe(true);
    expect(isDesignFile(penpot({ path: "README.md" }))).toBe(false);
  });
});

describe("DesignArtifact", () => {
  it("shows the rendered board when the server could produce one", () => {
    const container = render(
      <DesignArtifact
        artifact={artifactWith([
          penpot({
            design: {
              preview: { label: "01 · Shell · Home", dataUri: "data:image/svg+xml;base64,PHN2Zy8+" },
              boards: ["01 · Shell · Home", "02 · Observe · Fleet"],
            },
          }),
        ])}
      />,
    );
    const img = container.querySelector("[data-testid=design-preview-image]") as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(img.getAttribute("alt")).toContain("01 · Shell · Home");
  });

  it("falls back to board NAMES, and says they are names not a render", () => {
    const container = render(
      <DesignArtifact
        artifact={artifactWith([
          penpot({ design: { preview: null, boards: ["01 · Shell · Home", "02 · Observe"] } })
        ])}
      />,
    );
    const boards = container.querySelector("[data-testid=design-boards]");
    expect(boards?.textContent).toContain("01 · Shell · Home");
    expect(boards?.textContent).toContain("not from a render");
    expect(container.querySelector("[data-testid=design-preview-image]")).toBeNull();
  });

  it("states plainly that nothing could be shown when the archive was unreadable", () => {
    const container = render(<DesignArtifact artifact={artifactWith([penpot()])} />);
    expect(container.querySelector("[data-testid=design-no-preview]")?.textContent).toContain(
      "nothing about the visual change can be shown",
    );
    // The failure is never dressed up as an approved-looking empty state.
    expect(container.querySelector("[data-testid=design-preview-image]")).toBeNull();
    expect(container.querySelector("[data-testid=design-boards]")).toBeNull();
  });

  it("always offers the pull request as the way out", () => {
    const container = render(<DesignArtifact artifact={artifactWith([penpot()])} />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/sarala-ai/apex-design/pull/2",
    );
  });

  it("mentions the non-design files that rode along, without hiding them", () => {
    const container = render(
      <DesignArtifact
        artifact={artifactWith([penpot(), penpot({ path: "README.md", binary: false })])}
      />,
    );
    expect(container.querySelector("[data-testid=design-other-files]")?.textContent).toContain(
      "README.md",
    );
    expect(container.querySelectorAll("[data-testid=design-document]")).toHaveLength(1);
  });

  it("renders one block per design document when several changed", () => {
    const container = render(
      <DesignArtifact
        artifact={artifactWith([penpot(), penpot({ path: "product/other.penpot" })])}
      />,
    );
    expect(container.querySelectorAll("[data-testid=design-document]")).toHaveLength(2);
  });
});
