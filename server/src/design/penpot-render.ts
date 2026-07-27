/**
 * Server-side Penpot board renderer — logs into the live (self-hosted) Penpot
 * instance and renders a single board (frame) to PNG via its exporter service.
 *
 * Powers the Design tab's visual previews: the committed .penpot export tells
 * us the file/page/board ids; the live instance renders the pixels. Dev-only
 * credentials default to the compose "design" profile's standing account
 * (documented in docker-compose.yml); override via env for anything else.
 *
 * Format notes (verified against Penpot 2.16 by probing, same as the CLI
 * resource server): /api/export wants transit+json with keyword enums
 * (~:export-shapes, ~:png) and uuid-tagged ids (~u<uuid>); the response
 * carries a "~#uri" asset URL that must be fetched with the auth cookie.
 */

const BASE = (process.env.APEX_PENPOT_URL ?? "http://localhost:9001").replace(/\/$/, "");
const EMAIL = process.env.APEX_PENPOT_EMAIL ?? "apex-dev@penpot.local";
const PASSWORD = process.env.APEX_PENPOT_PASSWORD ?? "apex-penpot-dev-2026";

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 200;

interface CacheEntry {
  buf: Buffer;
  at: number;
}

const cache = new Map<string, CacheEntry>();

let session: { cookie: string; profileId: string } | null = null;

const kw = (s: string) => `~:${s}`;
const uid = (s: string) => `~u${s}`;

function tmap(...kv: unknown[]): unknown[] {
  const out: unknown[] = ["^ "];
  for (let i = 0; i < kv.length; i += 2) out.push(kv[i], kv[i + 1]);
  return out;
}

async function login(): Promise<{ cookie: string; profileId: string }> {
  const res = await fetch(`${BASE}/api/rpc/command/login-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`penpot login failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie?.split(";")[0];
  if (!cookie) throw new Error("penpot login returned no session cookie");
  const profile = (await res.json()) as { id?: string };
  if (!profile.id) throw new Error("penpot login returned no profile id");
  return { cookie, profileId: profile.id };
}

async function ensureSession(): Promise<{ cookie: string; profileId: string }> {
  if (session) return session;
  session = await login();
  return session;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

async function renderOnce(
  auth: { cookie: string; profileId: string },
  fileId: string,
  pageId: string,
  objectId: string,
  scale: number,
): Promise<Buffer> {
  const payload = tmap(
    kw("cmd"), kw("export-shapes"),
    kw("wait"), true,
    kw("profile-id"), uid(auth.profileId),
    kw("exports"), [tmap(
      kw("type"), kw("png"),
      kw("suffix"), "",
      kw("scale"), scale,
      kw("object-id"), uid(objectId),
      kw("page-id"), uid(pageId),
      kw("file-id"), uid(fileId),
      kw("name"), "board",
    )],
  );
  const res = await fetch(`${BASE}/api/export`, {
    method: "POST",
    headers: { "Content-Type": "application/transit+json", Cookie: auth.cookie },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`penpot export failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  const m = /"~#uri":"([^"]+)"/.exec(text);
  if (!m) throw new Error("penpot export returned no asset uri");
  const assetPath = m[1].replace(BASE, "").replace(/^https?:\/\/[^/]+/, "");
  const img = await fetch(`${BASE}${assetPath}`, { headers: { Cookie: auth.cookie } });
  if (!img.ok) throw new Error(`penpot asset fetch failed: ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

// Share links allow anonymous VIEW access (no comment, no inspect) so the
// cockpit can embed Penpot's view mode in an iframe without pushing dev
// credentials into the founder's browser. Penpot has no list-share-links RPC
// (verified 404), so we cache per file for this server's lifetime; duplicate
// links across restarts are inert rows, not a hazard.
const shareLinks = new Map<string, string>();

export async function ensureShareLink(fileId: string, pageIds: string[]): Promise<string> {
  const hit = shareLinks.get(fileId);
  if (hit) return hit;
  const auth = await ensureSession();
  const res = await fetch(`${BASE}/api/rpc/command/create-share-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Cookie: auth.cookie },
    body: JSON.stringify({ fileId, whoComment: "none", whoInspect: "none", pages: pageIds }),
  });
  if (!res.ok) throw new Error(`create-share-link failed: ${res.status}`);
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("create-share-link returned no id");
  shareLinks.set(fileId, body.id);
  return body.id;
}

export function penpotPublicBase(): string {
  return BASE;
}

/** Render a board to PNG, with a short TTL cache. Throws on any failure —
 *  the route maps that to 502 and the UI falls back to the badge summary. */
export async function renderBoardPng(
  fileId: string,
  pageId: string,
  objectId: string,
  scale = 0.35,
): Promise<Buffer> {
  const key = `${fileId}:${pageId}:${objectId}:${scale}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.buf;

  let auth = await ensureSession();
  let buf: Buffer;
  try {
    buf = await renderOnce(auth, fileId, pageId, objectId, scale);
  } catch (e) {
    // One retry with a fresh session — the standing cookie may have expired.
    session = null;
    auth = await ensureSession();
    buf = await renderOnce(auth, fileId, pageId, objectId, scale);
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { buf, at: Date.now() });
  return buf;
}
