/**
 * DESIGN artifact renderer — for pull requests carrying a design document
 * (`.penpot`, `.fig`, …).
 *
 * The problem it exists for: a design change currently renders as ONE row —
 * a binary file with +0/-0 — and the founder is asked to approve a board they
 * cannot see.
 *
 * What this renders is decided by what the server could honestly supply, and
 * NOTHING is invented:
 *  - `preview` present → the rendered image of the changed page/board;
 *  - otherwise `boards` present → the page/board names the change touches,
 *    parsed out of the design file itself;
 *  - otherwise the document is named, its unrenderable-ness is stated plainly,
 *    and the reviewer is sent to the tool that can show it.
 *
 * A design gate that cannot be previewed must SAY it cannot be previewed. It
 * must never look like a satisfied review.
 */
import { ExternalLink } from "lucide-react";
import type { ApprovalArtifact, ApprovalPrDiffFile } from "../../api/approvals";
import { StatusBadge } from "../StatusBadge";
import type { ArtifactRenderer } from "./registry";

const DESIGN_EXT_RE = /\.(penpot|fig|sketch|xd|afdesign)$/i;

export function isDesignFile(file: ApprovalPrDiffFile): boolean {
  return DESIGN_EXT_RE.test(file.path);
}

function DesignDocument({ file, prUrl }: { file: ApprovalPrDiffFile; prUrl: string }) {
  const preview = file.design?.preview ?? null;
  const boards = file.design?.boards ?? null;

  return (
    <li className="space-y-2 rounded-md border border-border/60 p-2.5" data-testid="design-document">
      <div className="flex items-center gap-2 text-xs">
        <StatusBadge status={file.status} />
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
      </div>

      {preview ? (
        <img
          src={preview.dataUri}
          alt={`Rendered preview of ${preview.label}`}
          className="w-full rounded border border-border/60 bg-background"
          data-testid="design-preview-image"
        />
      ) : boards && boards.length > 0 ? (
        <div className="space-y-1" data-testid="design-boards">
          <p className="text-(length:--text-micro) text-muted-foreground">
            Pages and boards in this document:
          </p>
          <div className="flex flex-wrap gap-1.5">
            {boards.map((board) => (
              <span
                key={board}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground"
              >
                {board}
              </span>
            ))}
          </div>
          <p className="text-(length:--text-micro) text-muted-foreground">
            No rendered image is available — these names are read from the design file itself, not
            from a render.
          </p>
        </div>
      ) : (
        <p className="text-(length:--text-micro) text-muted-foreground" data-testid="design-no-preview">
          This is a binary design document. Neither a rendered image nor the board names could be
          read for it, so nothing about the visual change can be shown here.
        </p>
      )}

      <a
        href={prUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
      >
        Open the pull request <ExternalLink className="size-3" aria-hidden />
      </a>
    </li>
  );
}

export function DesignArtifact({ artifact }: { artifact: ApprovalArtifact }) {
  const designFiles = artifact.files.filter(isDesignFile);
  const others = artifact.files.filter((file) => !isDesignFile(file));

  return (
    <div className="space-y-2" data-testid="artifact-design">
      <ul className="space-y-2">
        {designFiles.map((file) => (
          <DesignDocument key={file.path} file={file} prUrl={artifact.url} />
        ))}
      </ul>
      {others.length > 0 && (
        <p className="text-(length:--text-micro) text-muted-foreground" data-testid="design-other-files">
          {others.length} other file{others.length === 1 ? "" : "s"} changed alongside the design
          document: {others.map((file) => file.path).join(", ")}.
        </p>
      )}
    </div>
  );
}

export const designRenderer: ArtifactRenderer = {
  kind: "design",
  /** Declines when the server said "design" but no design document is
   *  actually in the changeset — the file list is then more honest. */
  match: (artifact) => artifact.files.some(isDesignFile),
  render: (artifact) => <DesignArtifact artifact={artifact} />,
};
