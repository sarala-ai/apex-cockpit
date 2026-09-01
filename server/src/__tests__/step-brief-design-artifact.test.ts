/**
 * Design preview for a flow-gate artifact.
 *
 * Ground truth is the REAL `.penpot` export produced by `apex run penpot
 * export-file` against a live self-hosted Penpot 2.16 (the same fixture the
 * Design surface's archive tests use). We never fabricate the format.
 *
 * The load-bearing property under test is honesty: a preview appears only
 * when the committed archive actually yielded one, and every failure path
 * leaves `design` absent so the renderer says "nothing could be read" instead
 * of implying the change was empty.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { enrichDesignFiles, readDesignEnrichment } from "../apex/steps/design-artifact.js";
import type { PullRequestFile } from "../apex/steps/brief.js";

const FIXTURE = fileURLToPath(
  new URL("../design/__fixtures__/apex-platform.penpot", import.meta.url),
);
const ARCHIVE = readFileSync(FIXTURE);

const penpotFile = (): PullRequestFile => ({
  path: "product/apex-platform.penpot",
  status: "modified",
  additions: 0,
  deletions: 0,
  binary: true,
});

describe("readDesignEnrichment", () => {
  it("reads board names and renders a board preview from the PR's own bytes", async () => {
    const fetchArchive = vi.fn().mockResolvedValue(ARCHIVE);

    const design = await readDesignEnrichment(
      fetchArchive,
      "sarala-ai/apex-design",
      "design/APE-5",
      "product/apex-platform.penpot",
    );

    // Fetched at the PULL REQUEST's head, not the default branch — the
    // proposed version is the entire point of a design gate.
    expect(fetchArchive).toHaveBeenCalledWith(
      "sarala-ai/apex-design",
      "product/apex-platform.penpot",
      "design/APE-5",
    );
    expect(design?.boards).toHaveLength(11);
    expect(design?.boards?.[0]).toContain("01 · Shell");
    expect(design?.preview?.label).toContain("01 · Shell");
    expect(design?.preview?.dataUri.startsWith("data:image/svg+xml;base64,")).toBe(true);

    // The preview is a real render of the real archive, not a placeholder.
    const svg = Buffer.from(design!.preview!.dataUri.split(",")[1]!, "base64").toString("utf8");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("viewBox");
  });

  it("returns null — never a fake preview — when the archive cannot be fetched", async () => {
    expect(
      await readDesignEnrichment(vi.fn().mockResolvedValue(null), "r", "b", "a.penpot"),
    ).toBeNull();
  });

  it("returns null when the fetch throws", async () => {
    expect(
      await readDesignEnrichment(vi.fn().mockRejectedValue(new Error("gh exploded")), "r", "b", "a.penpot"),
    ).toBeNull();
  });

  it("returns null when the bytes are not a readable Penpot export", async () => {
    expect(
      await readDesignEnrichment(
        vi.fn().mockResolvedValue(Buffer.from("not a zip at all")),
        "r",
        "b",
        "a.penpot",
      ),
    ).toBeNull();
  });
});

describe("enrichDesignFiles", () => {
  it("enriches every .penpot in the changeset and leaves other files alone", async () => {
    const files: PullRequestFile[] = [
      penpotFile(),
      { path: "README.md", status: "modified", additions: 1, deletions: 0 },
    ];

    await enrichDesignFiles({
      files,
      repo: "sarala-ai/apex-design",
      ref: "design/APE-5",
      fetchArchive: vi.fn().mockResolvedValue(ARCHIVE),
    });

    expect(files[0]!.design?.boards?.length).toBe(11);
    expect(files[1]!.design).toBeUndefined();
  });

  it("lets one unreadable document cost only itself", async () => {
    const files: PullRequestFile[] = [
      { ...penpotFile(), path: "good.penpot" },
      { ...penpotFile(), path: "broken.penpot" },
    ];
    const fetchArchive = vi.fn(async (_repo: string, path: string) =>
      path === "good.penpot" ? ARCHIVE : null,
    );

    await enrichDesignFiles({
      files,
      repo: "r",
      ref: "b",
      fetchArchive: fetchArchive as never,
    });

    expect(files[0]!.design?.boards?.length).toBe(11);
    expect(files[1]!.design).toBeUndefined();
  });
});
