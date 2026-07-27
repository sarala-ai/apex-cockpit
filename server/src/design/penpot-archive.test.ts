import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarizePenpotArchive } from "./penpot-archive.js";

// Real export produced by `apex run penpot export-file` against a live
// self-hosted Penpot 2.16 — not a hand-crafted archive (we never fabricate
// design-file formats; the fixture IS the format's ground truth).
const FIXTURE = fileURLToPath(new URL("./__fixtures__/apex-vision.penpot", import.meta.url));

describe("summarizePenpotArchive", () => {
  it("summarizes a real Penpot export: manifest, boards, object count", () => {
    const s = summarizePenpotArchive(readFileSync(FIXTURE));
    expect(s.format).toBe("penpot");
    expect((s.manifest as { type?: string }).type).toBe("penpot/export-files");
    expect(s.objectCount).toBe(37);
    // Six top-level boards, root frame excluded, sorted by name.
    expect(s.boards.map((b) => b.name)).toEqual([
      "01 · The condition",
      "02 · The hinge",
      "03 · One surface",
      "04 · The governed loop",
      "05 · Acceptance test",
      "06 · Real vs targeted",
    ]);
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
