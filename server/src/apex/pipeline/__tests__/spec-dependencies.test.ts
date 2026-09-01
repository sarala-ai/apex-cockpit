import { describe, it, expect } from "vitest";
import { parseSpecDependencies, detectSpecDependenciesMismatch } from "../spec-dependencies.js";

describe("parseSpecDependencies — reads from YAML front matter", () => {
  it("returns [] when body is empty", () => {
    expect(parseSpecDependencies("")).toEqual([]);
  });

  it("returns [] when there is no front matter", () => {
    const doc = `# My Spec\n\n## Task breakdown\n\nDo things.\n`;
    expect(parseSpecDependencies(doc)).toEqual([]);
  });

  it("returns [] when front matter has no dependencies field", () => {
    const doc = `---\ntitle: My Spec\n---\n\n# My Spec\n`;
    expect(parseSpecDependencies(doc)).toEqual([]);
  });

  it("returns [] when dependencies field is an empty array", () => {
    const doc = `---\ndependencies: []\n---\n\n# My Spec\n`;
    expect(parseSpecDependencies(doc)).toEqual([]);
  });

  it("extracts a single identifier from the front matter", () => {
    const doc = `---\ndependencies: [APEX-26]\n---\n\n# My Spec\n`;
    expect(parseSpecDependencies(doc)).toEqual(["APEX-26"]);
  });

  it("extracts multiple identifiers from the front matter", () => {
    const doc = `---\ndependencies:\n  - APEX-26\n  - APEX-51\n---\n\n# My Spec\n`;
    expect(parseSpecDependencies(doc)).toEqual(["APEX-26", "APEX-51"]);
  });

  it("deduplicates identifiers", () => {
    const doc = `---\ndependencies: [APEX-26, APEX-26]\n---\n\n# My Spec\n`;
    expect(parseSpecDependencies(doc)).toEqual(["APEX-26"]);
  });

  it("normalises identifiers to uppercase", () => {
    const doc = `---\ndependencies: [apex-26]\n---\n\n# My Spec\n`;
    expect(parseSpecDependencies(doc)).toEqual(["APEX-26"]);
  });

  it("does NOT extract identifiers from the ## Dependencies prose section", () => {
    const doc = [
      "# My Spec",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "",
    ].join("\n");
    expect(parseSpecDependencies(doc)).toEqual([]);
  });

  it("ignores prose identifiers even when front matter declares none", () => {
    const doc = [
      "---",
      "title: My Spec",
      "---",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "",
    ].join("\n");
    expect(parseSpecDependencies(doc)).toEqual([]);
  });

  it("skips non-string items in the dependencies array", () => {
    const doc = `---\ndependencies: [APEX-26, 42, APEX-51]\n---\n`;
    expect(parseSpecDependencies(doc)).toEqual(["APEX-26", "APEX-51"]);
  });
});

describe("detectSpecDependenciesMismatch", () => {
  it("returns null when both sources are empty", () => {
    const doc = `---\ntitle: Spec\n---\n\n# My Spec\n`;
    expect(detectSpecDependenciesMismatch(doc)).toBeNull();
  });

  it("returns null when both have no dependencies (no front matter field, no prose section)", () => {
    const doc = `# My Spec\n\n## Tasks\n\nDo things.\n`;
    expect(detectSpecDependenciesMismatch(doc)).toBeNull();
  });

  it("returns null when front matter and prose agree on one dep", () => {
    const doc = [
      "---",
      "dependencies: [APEX-26]",
      "---",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "",
    ].join("\n");
    expect(detectSpecDependenciesMismatch(doc)).toBeNull();
  });

  it("returns null when front matter and prose agree on multiple deps", () => {
    const doc = [
      "---",
      "dependencies: [APEX-26, APEX-51]",
      "---",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "- Blocked by: APEX-51",
      "",
    ].join("\n");
    expect(detectSpecDependenciesMismatch(doc)).toBeNull();
  });

  it("returns null when front matter empty and prose says None", () => {
    const doc = [
      "---",
      "dependencies: []",
      "---",
      "",
      "## Dependencies",
      "",
      "None",
      "",
    ].join("\n");
    expect(detectSpecDependenciesMismatch(doc)).toBeNull();
  });

  it("returns error when front matter has dep but prose section is absent", () => {
    const doc = [
      "---",
      "dependencies: [APEX-26]",
      "---",
      "",
      "# My Spec",
      "",
    ].join("\n");
    const result = detectSpecDependenciesMismatch(doc);
    expect(result).not.toBeNull();
    expect(result).toContain("APEX-26");
    expect(result).toContain("absent from ## Dependencies prose");
  });

  it("returns error when prose has dep but front matter field is absent", () => {
    const doc = [
      "---",
      "title: My Spec",
      "---",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "",
    ].join("\n");
    const result = detectSpecDependenciesMismatch(doc);
    expect(result).not.toBeNull();
    expect(result).toContain("APEX-26");
    expect(result).toContain("missing from front matter dependencies field");
  });

  it("returns error when prose has dep but no front matter at all", () => {
    const doc = [
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "",
    ].join("\n");
    const result = detectSpecDependenciesMismatch(doc);
    expect(result).not.toBeNull();
    expect(result).toContain("APEX-26");
  });

  it("returns error when front matter has dep X but prose lists dep Y", () => {
    const doc = [
      "---",
      "dependencies: [APEX-26]",
      "---",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-51",
      "",
    ].join("\n");
    const result = detectSpecDependenciesMismatch(doc);
    expect(result).not.toBeNull();
    expect(result).toContain("APEX-26");
    expect(result).toContain("APEX-51");
  });

  it("returns error when front matter has subset of prose deps", () => {
    const doc = [
      "---",
      "dependencies: [APEX-26]",
      "---",
      "",
      "## Dependencies",
      "",
      "- Blocked by: APEX-26",
      "- Blocked by: APEX-51",
      "",
    ].join("\n");
    const result = detectSpecDependenciesMismatch(doc);
    expect(result).not.toBeNull();
    expect(result).toContain("APEX-51");
  });
});
