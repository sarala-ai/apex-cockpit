/**
 * CODE artifact renderer — the diff the reviewer actually has to read.
 *
 * The file list told a founder that `server/src/foo.ts` changed by +40/-3. It
 * never told them WHAT changed, so approving a code gate meant either trusting
 * the agent or leaving the cockpit for GitHub. This renders the real unified
 * diff, per file, collapsible, with +/- colouring.
 *
 * Honesty rules, non-negotiable because this is an approval surface:
 *  - a truncated diff SAYS it is truncated, at the point it was cut;
 *  - a binary file SAYS it is binary rather than rendering as an empty diff;
 *  - a file whose patch the server could not supply says exactly that, and
 *    still links out to the pull request.
 */
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ApprovalArtifact, ApprovalPrDiffFile } from "../../api/approvals";
import { StatusBadge } from "../StatusBadge";
import type { ArtifactRenderer } from "./registry";

/** Files auto-expanded on first render. Beyond this the reviewer opens what
 *  they want, so a 40-file PR does not become an unreadable wall. */
const AUTO_EXPAND_FILES = 3;
/** Lines rendered per file before the renderer itself cuts (and says so). */
const MAX_LINES_PER_FILE = 400;

type DiffLineKind = "add" | "del" | "hunk" | "context" | "meta";

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

const LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-green-500/10 text-green-700 dark:text-green-300",
  del: "bg-red-500/10 text-red-700 dark:text-red-300",
  hunk: "bg-muted/70 text-muted-foreground",
  meta: "text-muted-foreground",
  context: "text-foreground/80",
};

export function DiffBody({ file }: { file: ApprovalPrDiffFile }) {
  if (file.binary) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="diff-binary">
        Binary file — no line-level diff exists for it.
      </p>
    );
  }
  if (!file.patch) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="diff-unavailable">
        {file.patch_truncated
          ? "This diff was too large to fetch — open the pull request to read it."
          : "No diff was returned for this file."}
      </p>
    );
  }

  const allLines = file.patch.split("\n");
  const cutByRenderer = allLines.length > MAX_LINES_PER_FILE;
  const lines = cutByRenderer ? allLines.slice(0, MAX_LINES_PER_FILE) : allLines;

  return (
    <div className="overflow-x-auto" data-testid="diff-body">
      <pre className="font-mono text-(length:--text-micro) leading-5">
        {lines.map((line, index) => {
          const kind = classifyDiffLine(line);
          return (
            <div key={index} className={`px-3 ${LINE_CLASS[kind]}`} data-diff-line={kind}>
              {line === "" ? " " : line}
            </div>
          );
        })}
      </pre>
      {(cutByRenderer || file.patch_truncated) && (
        <p
          className="border-t border-border/60 px-3 py-1.5 text-(length:--text-micro) text-amber-700 dark:text-amber-300"
          data-testid="diff-truncated"
        >
          Diff truncated
          {cutByRenderer ? ` after ${MAX_LINES_PER_FILE} lines` : ""} — open the pull request to
          read the rest.
        </p>
      )}
    </div>
  );
}

function FileDiff({ file, defaultOpen }: { file: ApprovalPrDiffFile; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <li className="overflow-hidden rounded-md border border-border/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 bg-muted/30 px-2.5 py-1.5 text-left text-xs hover:bg-muted/60"
      >
        <ChevronRight
          className={`size-3 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        <StatusBadge status={file.status} />
        <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
        <span className="shrink-0 text-muted-foreground">
          <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
        </span>
      </button>
      {open && <DiffBody file={file} />}
    </li>
  );
}

export function CodeArtifact({ artifact }: { artifact: ApprovalArtifact }) {
  return (
    <div className="space-y-1.5" data-testid="artifact-code">
      <ul className="space-y-1.5">
        {artifact.files.map((file, index) => (
          <FileDiff key={file.path} file={file} defaultOpen={index < AUTO_EXPAND_FILES} />
        ))}
      </ul>
      {artifact.files.length > AUTO_EXPAND_FILES && (
        <p className="text-(length:--text-micro) text-muted-foreground">
          The first {AUTO_EXPAND_FILES} files are expanded — open the rest as you need them.
        </p>
      )}
    </div>
  );
}

export const codeRenderer: ArtifactRenderer = {
  kind: "code",
  /** Declines when there is nothing to expand — the fallback file list is a
   *  better answer than an empty accordion. */
  match: (artifact) => artifact.files.length > 0,
  render: (artifact) => <CodeArtifact artifact={artifact} />,
};
