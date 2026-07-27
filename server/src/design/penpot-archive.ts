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
  page: string;
}

export interface PenpotSummary {
  format: "penpot";
  manifest: unknown;
  /** Top-level frames (boards) across all pages, root frames excluded. */
  boards: PenpotBoard[];
  objectCount: number;
  entryCount: number;
}

const OBJECT_PATH_RE = /^files\/[^/]+\/pages\/([^/]+)\/([^/]+)\.json$/;
const PAGE_PATH_RE = /^files\/[^/]+\/pages\/([^/]+)\.json$/;
const ROOT_FRAME_ID = "00000000-0000-0000-0000-000000000000";

export function summarizePenpotArchive(buf: Buffer): PenpotSummary {
  const entries = readEntries(buf);
  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new Error("no manifest.json — not a Penpot export");
  const manifest: unknown = JSON.parse(readEntryData(buf, manifestEntry).toString("utf8"));

  // Page id → name, so boards report the human page name, not a uuid.
  const pageNames = new Map<string, string>();
  for (const e of entries) {
    const m = PAGE_PATH_RE.exec(e.name);
    if (!m) continue;
    const page = JSON.parse(readEntryData(buf, e).toString("utf8")) as { name?: string };
    if (typeof page.name === "string") pageNames.set(m[1], page.name);
  }

  const boards: PenpotBoard[] = [];
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
    };
    if (obj.type === "frame" && obj.id !== ROOT_FRAME_ID && obj.parentId === ROOT_FRAME_ID) {
      boards.push({ id: obj.id ?? m[2], name: obj.name ?? "(unnamed)", page: pageNames.get(m[1]) ?? m[1] });
    }
  }
  boards.sort((a, b) => (a.page + a.name).localeCompare(b.page + b.name));
  return { format: "penpot", manifest, boards, objectCount, entryCount: entries.length };
}
