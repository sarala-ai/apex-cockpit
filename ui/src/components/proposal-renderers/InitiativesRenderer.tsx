import { GOAL_CLOSURES, type ProposalColumn } from "@paperclipai/shared";
import type { ProposalRenderer } from "./registry";

/**
 * The `initiatives` kind.
 *
 * Column order is a scanning order: title first (what is this), then the three
 * judgement fields the review is actually for (hypothesis, budget, stop
 * condition), then how it ended, then the long prose last so it cannot push the
 * scannable columns off-screen.
 *
 * `status` is absent on purpose — an initiative's status is derived from its
 * projects, so there is nothing here to correct.
 */
const columns: readonly ProposalColumn[] = [
  { key: "title", label: "Title", editable: true },
  { key: "hypothesis", label: "Hypothesis", editable: true, multiline: true },
  { key: "budget", label: "Budget", editable: true },
  { key: "stopCondition", label: "Stop condition", editable: true, multiline: true },
  { key: "closure", label: "Closure", editable: true, options: GOAL_CLOSURES },
  { key: "closureReason", label: "Closure reason", editable: true, multiline: true },
  { key: "description", label: "Description", editable: true, multiline: true },
];

export const initiativesRenderer: ProposalRenderer = {
  kind: "initiatives",
  label: "Initiative",
  columns,
  match: () => true,
};
