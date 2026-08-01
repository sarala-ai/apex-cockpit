// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { ApprovalArtifact, ApprovalPrDiffFile } from "../../api/approvals";
import { CodeArtifact, DiffBody, classifyDiffLine } from "./CodeRenderer";

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

const file = (over: Partial<ApprovalPrDiffFile> = {}): ApprovalPrDiffFile => ({
  path: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,2 +1,2 @@\n context\n-removed\n+added",
  binary: false,
  patch_truncated: false,
  ...over,
});

const artifactWith = (files: ApprovalPrDiffFile[]): ApprovalArtifact =>
  ({
    available: true,
    degraded: false,
    repo: "r",
    headBranch: "b",
    url: "u",
    title: "t",
    totals: { additions: 1, deletions: 1, changedFiles: files.length },
    files,
    files_truncated: false,
    acceptanceEvaluation: null,
    artifactKind: "code",
  }) as ApprovalArtifact;

describe("classifyDiffLine", () => {
  it("separates hunk headers, file metadata, additions, deletions and context", () => {
    expect(classifyDiffLine("@@ -1,2 +1,2 @@")).toBe("hunk");
    expect(classifyDiffLine("+++ b/src/a.ts")).toBe("meta");
    expect(classifyDiffLine("--- a/src/a.ts")).toBe("meta");
    expect(classifyDiffLine("+added")).toBe("add");
    expect(classifyDiffLine("-removed")).toBe("del");
    expect(classifyDiffLine(" unchanged")).toBe("context");
  });
});

describe("DiffBody", () => {
  it("renders the hunks with additions and deletions distinguished", () => {
    const container = render(<DiffBody file={file()} />);
    const kinds = [...container.querySelectorAll("[data-diff-line]")].map((el) =>
      el.getAttribute("data-diff-line"),
    );
    expect(kinds).toEqual(["hunk", "context", "del", "add"]);
    expect(container.textContent).toContain("+added");
  });

  it("says a binary file is binary instead of drawing an empty diff", () => {
    const container = render(
      <DiffBody file={file({ binary: true, patch: null, additions: 0, deletions: 0 })} />,
    );
    expect(container.querySelector("[data-testid=diff-binary]")).not.toBeNull();
    expect(container.querySelector("[data-testid=diff-body]")).toBeNull();
  });

  it("says so when the server could supply no patch at all", () => {
    const container = render(<DiffBody file={file({ patch: null })} />);
    expect(container.querySelector("[data-testid=diff-unavailable]")?.textContent).toContain(
      "No diff was returned",
    );
  });

  it("distinguishes a patch that was too large to fetch from a missing one", () => {
    const container = render(<DiffBody file={file({ patch: null, patch_truncated: true })} />);
    expect(container.querySelector("[data-testid=diff-unavailable]")?.textContent).toContain(
      "too large",
    );
  });

  it("truncates an enormous diff and SAYS it truncated it", () => {
    const huge = Array.from({ length: 900 }, (_, i) => `+line ${i}`).join("\n");
    const container = render(<DiffBody file={file({ patch: huge })} />);
    expect(container.querySelectorAll("[data-diff-line]")).toHaveLength(400);
    expect(container.querySelector("[data-testid=diff-truncated]")?.textContent).toContain(
      "after 400 lines",
    );
  });

  it("reports truncation the server already performed", () => {
    const container = render(<DiffBody file={file({ patch_truncated: true })} />);
    expect(container.querySelector("[data-testid=diff-truncated]")).not.toBeNull();
  });
});

describe("CodeArtifact", () => {
  it("expands the first files and leaves the rest collapsed", () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ path: `src/f${i}.ts` }));
    const container = render(<CodeArtifact artifact={artifactWith(files)} />);
    const buttons = [...container.querySelectorAll("button[aria-expanded]")];
    expect(buttons.map((b) => b.getAttribute("aria-expanded"))).toEqual([
      "true",
      "true",
      "true",
      "false",
      "false",
    ]);
    expect(container.querySelectorAll("[data-testid=diff-body]")).toHaveLength(3);
  });

  it("opens a collapsed file on click", () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ path: `src/f${i}.ts` }));
    const container = render(<CodeArtifact artifact={artifactWith(files)} />);
    const last = [...container.querySelectorAll("button[aria-expanded]")].at(-1) as HTMLButtonElement;
    act(() => {
      last.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(last.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll("[data-testid=diff-body]")).toHaveLength(4);
  });
});
