/**
 * Issue document keys that participate in the annotated review loop:
 * a human anchors threaded comments on passages of the document, and the
 * authoring agent wakes with those annotations in its review context.
 *
 * Order is significant: when an issue carries more than one reviewable
 * document and nothing else names a key, the first present key wins.
 */
export const REVIEWABLE_DOCUMENT_KEYS = ["plan", "spec"] as const;

export type ReviewableDocumentKey = (typeof REVIEWABLE_DOCUMENT_KEYS)[number];

export function isReviewableDocumentKey(value: unknown): value is ReviewableDocumentKey {
  return typeof value === "string"
    && (REVIEWABLE_DOCUMENT_KEYS as readonly string[]).includes(value);
}

/**
 * Picks the reviewable key to review when several are available, honouring
 * REVIEWABLE_DOCUMENT_KEYS order. Returns null when none are reviewable.
 */
export function pickReviewableDocumentKey(keys: readonly string[]): ReviewableDocumentKey | null {
  for (const key of REVIEWABLE_DOCUMENT_KEYS) {
    if (keys.includes(key)) return key;
  }
  return null;
}
