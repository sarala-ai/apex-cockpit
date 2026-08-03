/**
 * Review passes — the canonical vocabulary, ported into the cockpit.
 *
 * WHY THIS LIVES HERE NOW: until this migration, a gate's `requires` list
 * (the review-pass ids a founder is asked to run at a decision point) was
 * pure data in flow YAML, and the *wording* of each pass — the persona, the
 * one-line question — arrived over the wire from apex-core via
 * `apex flows show --output json`, which read it out of
 * `apex_platform/core/review_passes.py`. The cockpit rendered doctrine text
 * it never copied. That seam is being deleted along with the flow
 * front-end (docs/architecture/execution-substrate.md §5-6): the four typed
 * lifecycles are becoming database-backed pipeline definitions seeded once
 * at startup, the same way built-in agents are seeded from files into the
 * database, and there is no more `apex flows show` call for a review stage's
 * `gate.requires` to be resolved against at render time. So the catalogue
 * itself — not just the ids, the label/persona/question wording too — has
 * to be embedded here.
 *
 * apex-core's `review_passes.py` remains the upstream SOURCE OF THE WORDING.
 * This file is a verbatim transcription, not a reimplementation, and nothing
 * here may reword a question or invent a new id — that authority stays with
 * the Python module (and, above that, docs/architecture/review-passes.md).
 * Two independent copies of the same doctrine is a real drift hazard: if
 * apex-core's wording changes, this file goes stale silently because nothing
 * currently checks the two against each other. Worth a follow-up (e.g. a
 * generated-from-Python fixture, or a CI diff check) once there is a second
 * consumer to justify the machinery; for now the risk is accepted and named
 * rather than hidden.
 */

export type ReviewPass = {
  id: string;
  label: string;
  persona: string;
  question: string;
};

/**
 * Declaration order matters: this is DOCTRINE order (the order a person
 * would naturally walk the questions), not alphabetical. `REVIEW_PASS_IDS`
 * below preserves it for anything that needs an ordered list rather than a
 * lookup.
 */
const PASSES: ReviewPass[] = [
  {
    id: "customer_hat",
    label: "Customer hat",
    persona: "the person who sees this — operator, developer in the loop, or approver",
    question: "Would a first-time user understand this screen without knowing how it was built?",
  },
  {
    id: "cognitive_load",
    label: "Cognitive load",
    persona: "the reader making the decision",
    question: "Does this remove noise without hiding consequences?",
  },
  {
    id: "design",
    label: "Design",
    persona: "the next person to extend this",
    question:
      "Does this fit the system's shape, or is it a new mechanism solving the last mechanism's problem?",
  },
  {
    id: "system_compatibility",
    label: "System compatibility",
    persona: "every other consumer of the thing being changed",
    question: "What else assumes this — cross-repo contracts, wire shapes, config keys, env var names?",
  },
  {
    id: "reversibility",
    label: "Reversibility / blast radius",
    persona: "the person who has to undo this after data accumulates",
    question: "What does it cost to change this later, and is that cost visible now while it is still cheap?",
  },
  {
    id: "failure_degraded",
    label: "Failure & degraded",
    persona: "the user while a dependency is down",
    question: "What does the user see when a dependency is down, and does the primary action still work?",
  },
  {
    id: "decommission",
    label: "Decommission",
    persona: "whoever turns this off",
    question: "How is this turned off and removed, and what breaks when it goes?",
  },
  {
    id: "naming",
    label: "Naming",
    persona: "a stranger meeting the name somewhere we did not choose",
    question: "Does every new name still say what it is in a ticket, a URL, or a public comment?",
  },
  {
    id: "cost",
    label: "Cost",
    persona: "the person paying the monthly bill",
    question: "What does this cost per render, per run, per token?",
  },
];

/** Canonical catalog, keyed by identifier. The ONLY definition of these ids. */
export const REVIEW_PASSES: Record<string, ReviewPass> = Object.fromEntries(
  PASSES.map((pass) => [pass.id, pass]),
);

/** Declaration order — doctrine order, not alphabetical. */
export const REVIEW_PASS_IDS: readonly string[] = PASSES.map((pass) => pass.id);

/**
 * Normalize + validate a list of pass identifiers.
 *
 * Throws naming the unknown id AND the legal vocabulary — a typo'd pass is a
 * silently-skipped review, so this is never tolerated quietly. Also rejects
 * duplicates: listing the same pass twice is very likely a copy-paste error
 * masking a missing pass, not an intentional emphasis.
 */
export function validateReviewPassIds(ids: string[]): string[] {
  const normalized: string[] = [];
  for (const raw of ids) {
    const value = (raw ?? "").trim();
    if (!(value in REVIEW_PASSES)) {
      throw new Error(
        `unknown review pass ${JSON.stringify(raw)}; expected one of ${REVIEW_PASS_IDS.join(", ")} ` +
          "(see docs/architecture/review-passes.md).",
      );
    }
    if (normalized.includes(value)) {
      throw new Error(`review pass ${JSON.stringify(value)} listed more than once.`);
    }
    normalized.push(value);
  }
  return normalized;
}

/** The catalog subset a consumer needs to render `ids`. */
export function reviewPassCatalogFor(ids: string[]): Record<string, ReviewPass> {
  const catalog: Record<string, ReviewPass> = {};
  for (const id of ids) {
    const pass = REVIEW_PASSES[id];
    if (pass) catalog[id] = pass;
  }
  return catalog;
}
