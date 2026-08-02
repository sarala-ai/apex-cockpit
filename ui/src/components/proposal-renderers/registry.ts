/**
 * PROPOSAL-KIND RENDERER REGISTRY — the same seam, one object up.
 *
 * `artifact-renderers/registry.ts` established the contract: an artifact
 * declares a KIND, a renderer registers against it, and adding a renderer
 * requires ZERO changes to the gate surface. This registry applies that
 * contract to proposals, whose records are structured objects rather than
 * files.
 *
 * The difference worth naming: an artifact renderer returns a view, while a
 * proposal renderer must also declare which cells a reviewer may CORRECT.
 * Editability is part of the kind's identity — a reviewer must not be able to
 * edit a computed column, and the review surface must not have to know which
 * columns those are. So a renderer here is columns + an optional custom cell
 * renderer, and the grid is shared.
 *
 * There is always a fallback: an unregistered kind renders its records as
 * key/value rows, read-only. A new kind degrades to "readable but not
 * correctable", never to a blank card.
 */
import type { ReactNode } from "react";
import type { ProposalColumn, ProposalRecord } from "@paperclipai/shared";

export type ProposalRendererContext = {
  record: ProposalRecord;
  column: ProposalColumn;
  value: unknown;
};

export type ProposalRenderer = {
  /** The `kind` this renderer claims. Registering twice REPLACES the earlier. */
  kind: string;
  /** Human label for one record, e.g. "Initiative". Captions the grid. */
  label: string;
  /** Columns, in reading order. The server declares the same set; the UI
   *  prefers the server's when it has them so a kind stays single-sourced. */
  columns: readonly ProposalColumn[];
  /** Final say — lets a renderer decline a proposal it cannot handle so the
   *  fallback takes over, exactly as the artifact registry's `match` does. */
  match: (proposal: { kind: string; records: ProposalRecord[] }) => boolean;
  /** Optional per-cell display override. Returning undefined uses the default. */
  renderCell?: (context: ProposalRendererContext) => ReactNode | undefined;
};

const renderers = new Map<string, ProposalRenderer>();
let fallback: ProposalRenderer | null = null;

export function registerProposalRenderer(renderer: ProposalRenderer): void {
  renderers.set(renderer.kind, renderer);
}

export function setFallbackProposalRenderer(renderer: ProposalRenderer): void {
  fallback = renderer;
}

/** Test seam only — drop a registration so a fake kind cannot leak between tests. */
export function unregisterProposalRenderer(kind: string): void {
  renderers.delete(kind);
}

export function listProposalRenderers(): ProposalRenderer[] {
  return [...renderers.values()];
}

export function resolveProposalRenderer(proposal: {
  kind: string;
  records: ProposalRecord[];
}): ProposalRenderer {
  const claimed = renderers.get(proposal.kind);
  if (claimed && claimed.match(proposal)) return claimed;
  if (!fallback) {
    throw new Error(
      "No fallback proposal renderer installed — import ui/src/components/proposal-renderers first.",
    );
  }
  return fallback;
}
