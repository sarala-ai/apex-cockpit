import { describe, expect, it } from "vitest";
import {
  isReviewableDocumentKey,
  pickReviewableDocumentKey,
  REVIEWABLE_DOCUMENT_KEYS,
} from "./reviewable-documents.js";

describe("reviewable document keys", () => {
  it("keeps plan first so pre-existing plan behaviour is unchanged", () => {
    expect(REVIEWABLE_DOCUMENT_KEYS[0]).toBe("plan");
    expect(REVIEWABLE_DOCUMENT_KEYS).toContain("spec");
  });

  it("recognises reviewable keys and nothing else", () => {
    expect(isReviewableDocumentKey("plan")).toBe(true);
    expect(isReviewableDocumentKey("spec")).toBe(true);
    expect(isReviewableDocumentKey("notes")).toBe(false);
    expect(isReviewableDocumentKey("Plan")).toBe(false);
    expect(isReviewableDocumentKey(undefined)).toBe(false);
    expect(isReviewableDocumentKey(null)).toBe(false);
    expect(isReviewableDocumentKey(1)).toBe(false);
  });

  it("picks by declared priority, not by input order", () => {
    expect(pickReviewableDocumentKey(["spec", "plan"])).toBe("plan");
    expect(pickReviewableDocumentKey(["spec"])).toBe("spec");
    expect(pickReviewableDocumentKey(["notes", "spec"])).toBe("spec");
    expect(pickReviewableDocumentKey(["notes"])).toBeNull();
    expect(pickReviewableDocumentKey([])).toBeNull();
  });
});
