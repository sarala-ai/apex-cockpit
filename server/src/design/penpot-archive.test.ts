import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarizePenpotArchive } from "./penpot-archive.js";

// Real export produced by `apex run penpot export-file` against a live
// self-hosted Penpot 2.16 — not a hand-crafted archive (we never fabricate
// design-file formats; the fixture IS the format's ground truth). Multi-page:
// one page per surface, Current/Target frames + a Journeys page.
const FIXTURE = fileURLToPath(new URL("./__fixtures__/apex-platform.penpot", import.meta.url));

describe("summarizePenpotArchive", () => {
  it("summarizes a real Penpot export: manifest, boards with page names, object count", () => {
    const s = summarizePenpotArchive(readFileSync(FIXTURE));
    expect(s.format).toBe("penpot");
    expect((s.manifest as { type?: string }).type).toBe("penpot/export-files");
    expect(s.objectCount).toBe(782);
    // Board page attribution uses the human page name, not a uuid.
    expect([...new Set(s.boards.map((b) => b.page))]).toEqual([
      "01 · Shell",
      "02 · Observe",
      "03 · Design",
      "04 · Gateway",
      "05 · Pipelines",
      "06 · Journeys",
    ]);
    // Each surface page carries a Current and a Target frame; Journeys has one.
    expect(s.boards).toHaveLength(11);
    expect(s.boards.filter((b) => b.name.includes("Current")).length).toBe(5);
    expect(s.boards.filter((b) => b.name.includes("Target")).length).toBe(5);
  });

  it("rejects non-ZIP input with a clear error", () => {
    expect(() => summarizePenpotArchive(Buffer.from('{"version":"0.8.2"}'))).toThrow(
      /not a ZIP archive/,
    );
  });

  it("rejects a ZIP without a Penpot manifest", () => {
    // Minimal empty ZIP: just an end-of-central-directory record.
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    expect(() => summarizePenpotArchive(eocd)).toThrow(/no manifest\.json/);
  });
});
