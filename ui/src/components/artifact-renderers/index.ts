/**
 * Built-in artifact renderers, registered once at import time.
 *
 * This file is the ONLY place that has to change when a new artifact kind
 * gains a renderer — `ArtifactBlock` in ApprovalPayload.tsx resolves through
 * the registry and knows nothing about any specific kind.
 */
import { codeRenderer } from "./CodeRenderer";
import { designRenderer } from "./DesignRenderer";
import { fileListRenderer } from "./FileListRenderer";
import { registerArtifactRenderer, setFallbackArtifactRenderer } from "./registry";

setFallbackArtifactRenderer(fileListRenderer);
registerArtifactRenderer(codeRenderer);
registerArtifactRenderer(designRenderer);
// `plan` and `doc` deliberately have no renderer yet: markdown in a PR reads
// acceptably as a file list, and the code renderer's diff view already covers
// the case where they are the minority of a code change. They fall through to
// the fallback, which is the registry working as intended, not a gap.

export {
  registerArtifactRenderer,
  resolveArtifactRenderer,
  setFallbackArtifactRenderer,
  unregisterArtifactRenderer,
  listArtifactRenderers,
  type ArtifactRenderer,
} from "./registry";
