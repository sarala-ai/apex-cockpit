/**
 * Minimal .penpot archive reader — a Penpot export is a ZIP of plain JSON
 * (manifest.json + one JSON per file/page/object). We only need to *summarize*
 * it for the Design preview (boards, object counts, manifest), so this parses
 * the ZIP central directory with Node's built-in zlib instead of adding an
 * archive dependency for one read-only path.
 *
 * Scope guard: this is a summarizer, not a general ZIP library — no zip64, no
 * encryption, stored (0) and deflated (8) entries only. Anything outside that
 * throws, and the caller surfaces the error (never a silent empty preview).
 */
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface ZipEntry {
  name: string;
  compression: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readEntries(buf: Buffer): ZipEntry[] {
  // EOCD is at the end, preceded by an up-to-64KB comment — scan backwards.
  const scanStart = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory)");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CDIR_SIG) throw new Error("corrupt central directory");
    const compression = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localHeaderOffset = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    entries.push({ name, compression, compressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf: Buffer, e: ZipEntry): Buffer {
  if (buf.readUInt32LE(e.localHeaderOffset) !== LOCAL_SIG) {
    throw new Error(`corrupt local header for ${e.name}`);
  }
  // Local header name/extra lengths can differ from the central directory's.
  const nameLen = buf.readUInt16LE(e.localHeaderOffset + 26);
  const extraLen = buf.readUInt16LE(e.localHeaderOffset + 28);
  const start = e.localHeaderOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compressedSize);
  if (e.compression === 0) return Buffer.from(raw);
  if (e.compression === 8) return inflateRawSync(raw);
  throw new Error(`unsupported ZIP compression method ${e.compression} for ${e.name}`);
}

export interface PenpotBoard {
  id: string;
  name: string;
  /** Human page name (falls back to the page uuid when unnamed). */
  page: string;
  /** Page uuid — needed to render/deep-link the board on the live instance. */
  pageId: string;
}

/** shapeId -> destination board id, harvested from every shape's
 *  navigate-interactions. The cockpit renders boards as inline SVG (whose
 *  `<g id="shape-{uuid}">` ids match these keys) and drives navigation from
 *  this map — so click-through is OUR behaviour, not Penpot's viewer's. */
export type PenpotNavMap = Record<string, string>;

export interface PenpotSummary {
  format: "penpot";
  manifest: unknown;
  /** The exported Penpot file's id (from the manifest) — lets the UI deep-link
   *  into the live Penpot instance this export came from. */
  fileId: string | null;
  /** Pages in archive order (first page = the natural view-mode entry). */
  pages: { id: string; name: string }[];
  /** Top-level frames (boards) across all pages, root frames excluded. */
  boards: PenpotBoard[];
  objectCount: number;
  entryCount: number;
  nav: PenpotNavMap;
}

const OBJECT_PATH_RE = /^files\/[^/]+\/pages\/([^/]+)\/([^/]+)\.json$/;

const PAGE_PATH_RE = /^files\/[^/]+\/pages\/([^/]+)\.json$/;
const ROOT_FRAME_ID = "00000000-0000-0000-0000-000000000000";

export function summarizePenpotArchive(buf: Buffer): PenpotSummary {
  const entries = readEntries(buf);
  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new Error("no manifest.json — not a Penpot export");
  const manifest: unknown = JSON.parse(readEntryData(buf, manifestEntry).toString("utf8"));
  const manifestFiles = (manifest as { files?: { id?: string }[] }).files;
  const fileId = manifestFiles?.[0]?.id ?? null;

  // Page id → name, so boards report the human page name, not a uuid.
  const pageNames = new Map<string, string>();
  for (const e of entries) {
    const m = PAGE_PATH_RE.exec(e.name);
    if (!m) continue;
    const page = JSON.parse(readEntryData(buf, e).toString("utf8")) as { name?: string };
    if (typeof page.name === "string") pageNames.set(m[1], page.name);
  }

  const boards: PenpotBoard[] = [];
  const nav: PenpotNavMap = {};
  let objectCount = 0;
  for (const e of entries) {
    const m = OBJECT_PATH_RE.exec(e.name);
    if (!m) continue;
    objectCount++;
    const obj = JSON.parse(readEntryData(buf, e).toString("utf8")) as {
      id?: string;
      name?: string;
      type?: string;
      parentId?: string;
      interactions?: { actionType?: string; destination?: string }[];
    };
    const jump = obj.interactions?.find((i) => i.actionType === "navigate" && i.destination);
    if (jump?.destination && obj.id) nav[obj.id] = jump.destination;
    if (obj.type === "frame" && obj.id !== ROOT_FRAME_ID && obj.parentId === ROOT_FRAME_ID) {
      boards.push({
        id: obj.id ?? m[2],
        name: obj.name ?? "(unnamed)",
        page: pageNames.get(m[1]) ?? m[1],
        pageId: m[1],
      });
    }
  }
  boards.sort((a, b) => (a.page + a.name).localeCompare(b.page + b.name));
  const pages = [...pageNames.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { format: "penpot", manifest, fileId, pages, boards, objectCount, entryCount: entries.length, nav };
}

/* ------------------------------------------------------------------------ */
/* Deterministic archive → SVG renderer                                       */
/*                                                                            */
/* The cockpit renders committed designs itself, offline, from the file in    */
/* git — no live Penpot, no exporter, no headless browser. That is not just    */
/* simpler: Penpot's own headless renderer draws text through <foreignObject> */
/* and races, dropping a different subset of labels on every run (verified     */
/* across three failed hypotheses). Emitting real <text> makes completeness a  */
/* property of the code instead of a gamble.                                   */
/*                                                                            */
/* Scope: the shape subset our boards use (frame/rect/circle/text). Anything   */
/* else is skipped rather than guessed at — a design using richer Penpot       */
/* features should be committed as a rendered SVG by its author.               */
/* ------------------------------------------------------------------------ */

interface RawShape {
  id?: string;
  name?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rx?: number;
  frameId?: string;
  fills?: { fillColor?: string; fillOpacity?: number }[];
  strokes?: { strokeColor?: string; strokeWidth?: number }[];
  content?: {
    children?: { children?: { children?: { text?: string; fontSize?: string; fontWeight?: string; fills?: { fillColor?: string }[] }[] }[] }[];
  };
}

const FONT_STACK =
  "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fillOf(s: RawShape): { color: string; opacity: number } | null {
  const f = s.fills?.[0];
  if (!f?.fillColor) return null;
  return { color: f.fillColor, opacity: f.fillOpacity ?? 1 };
}

/** Render one board (top-level frame) of an archive to standalone SVG. */
export function renderBoardSvgFromArchive(buf: Buffer, boardId: string): string {
  const entries = readEntries(buf);
  const shapes: RawShape[] = [];
  let board: RawShape | null = null;
  for (const e of entries) {
    if (!OBJECT_PATH_RE.test(e.name)) continue;
    const o = JSON.parse(readEntryData(buf, e).toString("utf8")) as RawShape;
    if (o.id === boardId) board = o;
    else if (o.frameId === boardId) shapes.push(o);
  }
  if (!board) throw new Error("board not found in archive");

  const ox = board.x ?? 0;
  const oy = board.y ?? 0;
  const w = board.width ?? 1500;
  const h = board.height ?? 1000;

  // Painter's order: the archive's z-order is unreliable after scripted edits,
  // so paint panels (largest first) then marks, then text on top. That matches
  // how these boards are built and avoids text hiding behind its own card.
  const rank = (s: RawShape) => (s.type === "text" ? 2 : s.type === "circle" ? 1 : 0);
  const area = (s: RawShape) => (s.width ?? 0) * (s.height ?? 0);
  shapes.sort((a, b) => rank(a) - rank(b) || area(b) - area(a));

  const out: string[] = [];
  const bg = fillOf(board);
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMin meet" font-family="${FONT_STACK}">`,
  );
  out.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${bg?.color ?? "#0a0a0a"}"/>`);

  for (const s of shapes) {
    const x = (s.x ?? 0) - ox;
    const y = (s.y ?? 0) - oy;
    const id = s.id ? ` id="shape-${s.id}"` : "";
    if (s.type === "rect" || s.type === "frame") {
      const f = fillOf(s);
      const st = s.strokes?.[0];
      const stroke = st?.strokeColor
        ? ` stroke="${st.strokeColor}" stroke-width="${st.strokeWidth ?? 1}"`
        : "";
      out.push(
        `<rect${id} x="${x}" y="${y}" width="${s.width ?? 0}" height="${s.height ?? 0}" rx="${s.rx ?? 0}" fill="${f?.color ?? "none"}" fill-opacity="${f?.opacity ?? 1}"${stroke}/>`,
      );
    } else if (s.type === "circle") {
      const f = fillOf(s);
      const rx = (s.width ?? 0) / 2;
      const ry = (s.height ?? 0) / 2;
      out.push(
        `<ellipse${id} cx="${x + rx}" cy="${y + ry}" rx="${rx}" ry="${ry}" fill="${f?.color ?? "none"}" fill-opacity="${f?.opacity ?? 1}"/>`,
      );
    } else if (s.type === "text") {
      const paras = s.content?.children?.[0]?.children ?? [];
      let dy = 0;
      const lines: string[] = [];
      for (const p of paras) {
        const run = p.children?.[0];
        if (!run?.text) continue;
        const size = parseFloat(run.fontSize ?? "14");
        const weight = run.fontWeight ?? "400";
        const color = run.fills?.[0]?.fillColor ?? "#fafafa";
        dy += size * 1.15;
        lines.push(
          `<text x="${x}" y="${y + dy}" font-size="${size}" font-weight="${weight}" fill="${color}">${esc(run.text)}</text>`,
        );
        dy += size * 0.35;
      }
      if (lines.length) out.push(`<g${id}>${lines.join("")}</g>`);
    }
  }
  out.push("</svg>");
  return out.join("");
}
