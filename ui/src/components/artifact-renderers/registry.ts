/**
 * ARTIFACT-RENDERER REGISTRY — the seam.
 *
 * Founder critique this answers: every approval renders the same way. A flow
 * gate shows a flat list of changed files, so a DESIGN change shows exactly
 * one row — a binary `.penpot` file — and the founder cannot see what they are
 * approving. A code change shows filenames and +/- counts but never the diff.
 *
 * The fix is not "add a special case for .penpot to ArtifactBlock". It is a
 * seam: an artifact declares its KIND (classified once, server-side, in
 * `server/src/apex/flow/brief.ts`), and this registry maps kind → renderer.
 * Adding a renderer for a new artifact type requires ZERO changes to
 * FlowGatePayload or ArtifactBlock — you register an entry, and it renders.
 *
 * There is always a fallback: the file-list rendering that shipped before
 * this registry existed. An unregistered kind degrades to it rather than to a
 * blank card, so a new artifact type is never worse than the status quo.
 */
import type { ReactNode } from "react";
import type { ApprovalArtifact } from "../../api/approvals";

export type ArtifactRenderer = {
  /** The `artifactKind` this renderer claims. Also its registry identity —
   *  registering the same kind twice REPLACES the earlier entry. */
  kind: string;
  /** Final say on whether this renderer can handle a given artifact. Kind is
   *  matched first; `match` lets a renderer decline (e.g. a design renderer
   *  with no readable board data) so the fallback takes over. */
  match: (artifact: ApprovalArtifact) => boolean;
  render: (artifact: ApprovalArtifact) => ReactNode;
};

const renderers = new Map<string, ArtifactRenderer>();
let fallback: ArtifactRenderer | null = null;

export function registerArtifactRenderer(renderer: ArtifactRenderer): void {
  renderers.set(renderer.kind, renderer);
}

/** The renderer used when no registered kind claims the artifact. */
export function setFallbackArtifactRenderer(renderer: ArtifactRenderer): void {
  fallback = renderer;
}

/** Test seam only — drop a registration so a fake kind cannot leak between tests. */
export function unregisterArtifactRenderer(kind: string): void {
  renderers.delete(kind);
}

export function listArtifactRenderers(): ArtifactRenderer[] {
  return [...renderers.values()];
}

/**
 * Resolve the renderer for an artifact: the entry registered under its
 * declared kind if that entry also accepts it, otherwise the fallback.
 * Never returns null — the fallback is always installed by
 * `artifact-renderers/index.ts`.
 */
export function resolveArtifactRenderer(artifact: ApprovalArtifact): ArtifactRenderer {
  const claimed = renderers.get(artifact.artifactKind);
  if (claimed && claimed.match(artifact)) return claimed;
  if (!fallback) {
    throw new Error(
      "No fallback artifact renderer installed — import ui/src/components/artifact-renderers first.",
    );
  }
  return fallback;
}
