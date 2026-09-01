/**
 * The FALLBACK renderer — exactly the rendering flow gates had before the
 * artifact-renderer registry existed: status badge, path, +/- counts, one row
 * per changed file.
 *
 * It stays the fallback deliberately. An artifact kind nobody has written a
 * renderer for yet degrades to this, which is honest and useful, rather than
 * to a blank card or a guess.
 */
import type { ApprovalArtifact, ApprovalPrDiffFile } from "../../api/approvals";
import { StatusBadge } from "../StatusBadge";
import type { ArtifactRenderer } from "./registry";

export function PullRequestFileRow({ file }: { file: ApprovalPrDiffFile }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <StatusBadge status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
      <span className="shrink-0 text-muted-foreground">
        <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{" "}
        <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
      </span>
    </li>
  );
}

export function FileListArtifact({ artifact }: { artifact: ApprovalArtifact }) {
  if (artifact.files.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="artifact-file-list">
        No changed files were reported for this pull request.
      </p>
    );
  }
  return (
    <ul className="space-y-1 border-t border-border/60 pt-2" data-testid="artifact-file-list">
      {artifact.files.map((file) => (
        <PullRequestFileRow key={file.path} file={file} />
      ))}
    </ul>
  );
}

export const fileListRenderer: ArtifactRenderer = {
  kind: "unknown",
  match: () => true,
  render: (artifact) => <FileListArtifact artifact={artifact} />,
};
