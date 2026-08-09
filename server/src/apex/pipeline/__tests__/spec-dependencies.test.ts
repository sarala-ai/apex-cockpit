import { describe, it, expect } from "vitest";
import { parseSpecDependencies } from "../spec-dependencies.js";

describe("parseSpecDependencies", () => {
  it("returns [] when body is empty", () => {
    expect(parseSpecDependencies("")).toEqual([]);
  });

  it("returns [] when there is no ## Dependencies section", () => {
    const body = `# My Spec\n\n## Task breakdown\n\nDo things.\n`;
    expect(parseSpecDependencies(body)).toEqual([]);
  });

  it("returns [] when the section body is 'None'", () => {
    const body = `# My Spec\n\n## Dependencies\n\nNone\n\n## Tasks\n\nDo things.\n`;
    expect(parseSpecDependencies(body)).toEqual([]);
  });

  it("returns [] when the section body is 'none' (case-insensitive)", () => {
    const body = `# My Spec\n\n## Dependencies\n\nnone\n\n## Tasks\n\nDo things.\n`;
    expect(parseSpecDependencies(body)).toEqual([]);
  });

  it("returns [] when the section body is 'NONE' (uppercase)", () => {
    const body = `# My Spec\n\n## Dependencies\n\nNONE\n`;
    expect(parseSpecDependencies(body)).toEqual([]);
  });

  it("extracts a single APEX-N identifier", () => {
    const body = `# My Spec\n\n## Dependencies\n\n- Blocked by: APEX-26\n\n## Tasks\n\nDo things.\n`;
    expect(parseSpecDependencies(body)).toEqual(["APEX-26"]);
  });

  it("extracts multiple identifiers", () => {
    const body = `# My Spec\n\n## Dependencies\n\n- Blocked by: APEX-26\n- Blocked by: APEX-51\n\n## Tasks\n`;
    expect(parseSpecDependencies(body)).toEqual(["APEX-26", "APEX-51"]);
  });

  it("deduplicates identifiers", () => {
    const body = `# My Spec\n\n## Dependencies\n\n- Blocked by: APEX-26\n- Blocked by: APEX-26\n`;
    expect(parseSpecDependencies(body)).toEqual(["APEX-26"]);
  });

  it("does not extract identifiers from outside the Dependencies section", () => {
    const body = `# My Spec\n\nThis relates to APEX-99.\n\n## Dependencies\n\nNone\n\n## Tasks\n\nSee APEX-100.\n`;
    expect(parseSpecDependencies(body)).toEqual([]);
  });

  it("does not extract identifiers from sections before Dependencies", () => {
    const body = `# APEX-10 Spec\n\n## Background\n\nRelated to APEX-20.\n\n## Dependencies\n\n- Blocked by: APEX-26\n`;
    expect(parseSpecDependencies(body)).toEqual(["APEX-26"]);
  });

  it("normalises identifiers to uppercase", () => {
    const body = `## Dependencies\n\n- Blocked by: apex-26\n`;
    expect(parseSpecDependencies(body)).toEqual(["APEX-26"]);
  });

  it("stops at the next ## heading", () => {
    const body = `## Dependencies\n\n- Blocked by: APEX-26\n\n## Tasks\n\nAPEX-99 referenced here.\n`;
    expect(parseSpecDependencies(body)).toEqual(["APEX-26"]);
  });

  it("handles a spec with no sections after Dependencies", () => {
    const body = `## Dependencies\n\n- Blocked by: APEX-62\n- Blocked by: APEX-63\n`;
    expect(parseSpecDependencies(body)).toEqual(["APEX-62", "APEX-63"]);
  });
});
