import { afterEach, describe, expect, it } from "vitest";
import {
  registerProposalRenderer,
  resolveProposalRenderer,
  unregisterProposalRenderer,
  listProposalRenderers,
  type ProposalRenderer,
} from "./index";
import { fallbackColumnsFor } from "./FallbackRenderer";

/**
 * A fake kind, exactly as the artifact-renderer registry's own tests use one:
 * the point of a registry is that a kind NOBODY wrote into the review surface
 * still renders, so the proof has to be a kind the surface has never heard of.
 */
const fakeKind = "attribution-corrections";

afterEach(() => unregisterProposalRenderer(fakeKind));

const fakeRenderer: ProposalRenderer = {
  kind: fakeKind,
  label: "Attribution correction",
  columns: [{ key: "who", label: "Who", editable: true }],
  match: () => true,
};

describe("proposal renderer registry", () => {
  it("resolves the registered renderer for a kind", () => {
    registerProposalRenderer(fakeRenderer);
    const resolved = resolveProposalRenderer({ kind: fakeKind, records: [] });
    expect(resolved.kind).toBe(fakeKind);
    expect(resolved.columns[0].key).toBe("who");
  });

  it("registering a kind requires no change to the review surface", () => {
    const before = listProposalRenderers().length;
    registerProposalRenderer(fakeRenderer);
    expect(listProposalRenderers().length).toBe(before + 1);
  });

  it("falls back for an unregistered kind rather than throwing", () => {
    const resolved = resolveProposalRenderer({ kind: "never-registered", records: [] });
    expect(resolved.kind).toBe("__fallback__");
  });

  it("lets a renderer decline, so the fallback takes over", () => {
    registerProposalRenderer({ ...fakeRenderer, match: () => false });
    expect(resolveProposalRenderer({ kind: fakeKind, records: [] }).kind).toBe("__fallback__");
  });

  it("re-registering the same kind replaces the earlier entry", () => {
    registerProposalRenderer(fakeRenderer);
    registerProposalRenderer({ ...fakeRenderer, label: "Replaced" });
    expect(resolveProposalRenderer({ kind: fakeKind, records: [] }).label).toBe("Replaced");
  });

  it("ships the initiatives kind", () => {
    const resolved = resolveProposalRenderer({ kind: "initiatives", records: [] });
    expect(resolved.columns.map((column) => column.key)).toEqual([
      "title",
      "hypothesis",
      "budget",
      "stopCondition",
      "closure",
      "closureReason",
      "description",
    ]);
  });

  it("derives read-only columns for an unknown kind, so it is readable not blank", () => {
    const columns = fallbackColumnsFor([
      { ref: "r1", provenance: { kind: "inferred" }, fields: { who: "a", when: "b" } },
      { ref: "r2", provenance: { kind: "confirmed" }, fields: { who: "c", why: "d" } },
    ] as never);
    expect(columns.map((column) => column.key)).toEqual(["who", "when", "why"]);
    expect(columns.every((column) => !column.editable)).toBe(true);
  });
});
