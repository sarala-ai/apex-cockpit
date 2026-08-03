/**
 * DESIGN preview for a flow-gate artifact.
 *
 * The founder critique in one line: a design gate shows a single row for a
 * binary `.penpot` and asks for an approval. This module is what makes that
 * row into something you can look at.
 *
 * How, and why THIS way: the `.penpot` export is a ZIP of JSON, and the
 * cockpit already reads it offline (`server/src/design/penpot-archive.ts`
 * summarizes pages/boards and renders a board to standalone SVG for the
 * Design surface). So the preview here is produced from the pull request's
 * OWN committed bytes — no live Penpot instance, no exporter service, no
 * headless browser, nothing that can be down when a reviewer opens a gate.
 *
 * What it deliberately does NOT claim: this is the proposed version of the
 * board, not a visual DIFF against the base. The label says exactly that, and
 * a failure to read the archive leaves `design` absent so the renderer can
 * say "nothing could be read" rather than imply an empty change.
 */
import { summarizePenpotArchive, renderBoardSvgFromArchive } from "../../design/penpot-archive.js";
import type { PullRequestFile } from "./brief.js";

/** Refuse to inline a preview past this — a brief is a decision aid, not an
 *  asset pipeline. Over budget we still ship the board NAMES. */
const MAX_PREVIEW_BYTES = 400_000;

const PENPOT_RE = /\.penpot$/i;

export type DesignArchiveFetcher = (
  repo: string,
  path: string,
  ref: string,
) => Promise<Buffer | null>;

export type DesignFileEnrichment = NonNullable<PullRequestFile["design"]>;

/** Build the design block for one `.penpot` path, or null when nothing could
 *  honestly be read. Never throws: a gate must render even if gh, the archive
 *  or the renderer misbehaves. */
export async function readDesignEnrichment(
  fetchArchive: DesignArchiveFetcher,
  repo: string,
  ref: string,
  path: string,
): Promise<DesignFileEnrichment | null> {
  let buf: Buffer | null = null;
  try {
    buf = await fetchArchive(repo, path, ref);
  } catch {
    return null;
  }
  if (!buf || buf.length === 0) return null;

  let boards: { id: string; name: string; page: string }[];
  try {
    boards = summarizePenpotArchive(buf).boards;
  } catch {
    // Not a readable Penpot export (a .fig, a corrupt blob, a future format).
    return null;
  }
  if (boards.length === 0) return null;

  const names = boards.map((b) => `${b.page} · ${b.name}`);

  // One board is previewed, not all of them: a brief should fit on a screen.
  // The first board of the first page is the document's natural entry point,
  // and the label names it so the reviewer is never guessing what they see.
  const first = boards[0]!;
  let preview: DesignFileEnrichment["preview"] = null;
  try {
    const svg = renderBoardSvgFromArchive(buf, first.id);
    if (svg.length <= MAX_PREVIEW_BYTES) {
      preview = {
        label: `${first.page} · ${first.name}`,
        dataUri: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
      };
    }
  } catch {
    preview = null; // Board names alone are still worth far more than a filename.
  }

  return { preview, boards: names };
}

/**
 * Enrich every `.penpot` file of a design artifact in place. Failure-isolated
 * per file, same doctrine as the rest of the brief: one unreadable document
 * never costs the reviewer the others.
 */
export async function enrichDesignFiles(input: {
  files: PullRequestFile[];
  repo: string;
  ref: string;
  fetchArchive: DesignArchiveFetcher;
}): Promise<void> {
  const targets = input.files.filter((file) => PENPOT_RE.test(file.path));
  await Promise.all(
    targets.map(async (file) => {
      const design = await readDesignEnrichment(
        input.fetchArchive,
        input.repo,
        input.ref,
        file.path,
      );
      if (design) file.design = design;
    }),
  );
}
