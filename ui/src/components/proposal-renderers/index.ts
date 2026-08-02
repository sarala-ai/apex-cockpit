/**
 * Built-in proposal-kind renderers, registered once at import time.
 *
 * This file is the ONLY place that changes when a new kind gains a renderer —
 * `ProposalReview` resolves through the registry and knows no kind's name.
 */
import { fallbackProposalRenderer } from "./FallbackRenderer";
import { initiativesRenderer } from "./InitiativesRenderer";
import { registerProposalRenderer, setFallbackProposalRenderer } from "./registry";

setFallbackProposalRenderer(fallbackProposalRenderer);
registerProposalRenderer(initiativesRenderer);
// Exactly one kind ships. A second kind built before the first has a real
// reviewer would be a guess about a shape nobody has scanned yet; the registry
// is what makes adding it later cheap, and that is what one kind proves.

export {
  registerProposalRenderer,
  resolveProposalRenderer,
  setFallbackProposalRenderer,
  unregisterProposalRenderer,
  listProposalRenderers,
  type ProposalRenderer,
} from "./registry";
