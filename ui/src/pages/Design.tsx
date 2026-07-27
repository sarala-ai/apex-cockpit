// Design — design-as-code for this company. Discovers .penpot exports (and
// legacy .op files) across the company's BOUND repos (placement-agnostic: a
// standalone design repo and an in-repo design/ dir are both just bindings),
// grouped by repo, with a summarized preview (boards + manifest for Penpot
// archives). Read-only surface: authoring happens in Penpot (self-hosted,
// `--profile design`) by hand or via apex-core's penpot resource server;
// review happens in PRs — draft = open PR, approved = merged (git-native
// status, no filename versioning).

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileJson } from "lucide-react";
import { designApi } from "@/api/design";
import { useCompany } from "@/context/CompanyContext";
import { Badge } from "@/components/ui/badge";
import type { DesignFileEntry } from "@paperclipai/shared";

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentPreview({ file }: { file: DesignFileEntry }) {
  const doc = useQuery({
    queryKey: ["design", "file", file.repo, file.path],
    queryFn: () => designApi.file(file.repo, file.path),
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  if (doc.isLoading) return <p className="text-xs text-muted-foreground">Loading document…</p>;
  if (doc.isError || !doc.data) {
    return <p className="text-xs text-rose-600 dark:text-rose-400">Failed to load document.</p>;
  }
  if (doc.data.parseError) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-400">
        Document could not be parsed: {doc.data.parseError}
      </p>
    );
  }
  const d = doc.data.document;
  const isPenpot =
    d != null && typeof d === "object" && (d as { format?: unknown }).format === "penpot";
  if (isPenpot) return <PenpotPreview doc={d as PenpotSummaryDoc} />;
  const topKeys = d && typeof d === "object" && !Array.isArray(d) ? Object.keys(d as object) : [];
  return (
    <div className="space-y-2">
      {topKeys.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {topKeys.slice(0, 12).map((k) => (
            <Badge key={k} variant="default">
              {k}
            </Badge>
          ))}
        </div>
      )}
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] leading-relaxed">
        {JSON.stringify(d, null, 2)?.slice(0, 20_000)}
      </pre>
    </div>
  );
}

interface PenpotSummaryDoc {
  fileId?: string | null;
  pages?: { id: string; name: string }[];
  boards?: { id: string; name: string; page: string; pageId: string }[];
  objectCount?: number;
  /** shapeId -> destination board id (from the archive's interactions). */
  nav?: Record<string, string>;
  penpotEditUrl?: string;
}

/** The design, rendered by US: Penpot's exporter emits the board as SVG, the
 *  cockpit inlines it and drives click-through from the archive's interaction
 *  map. No iframe, no share link, no Penpot session — viewing is ours, and
 *  editing stays governed (MCP, or a ticket that updates the file). */
function PenpotPreview({ doc }: { doc: PenpotSummaryDoc }) {
  const boards = doc.boards ?? [];
  const [boardId, setBoardId] = useState<string>(boards[0]?.id ?? "");
  const active = boards.find((b) => b.id === boardId) ?? boards[0];
  const nav = doc.nav ?? {};

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {boards.length > 1 && (
          <select
            value={active?.id ?? ""}
            onChange={(e) => setBoardId(e.target.value)}
            className="h-7 max-w-[26rem] rounded-md border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Select board"
          >
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.page} · {b.name}
              </option>
            ))}
          </select>
        )}
        {doc.penpotEditUrl && (
          <a
            href={doc.penpotEditUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            title="Authoring happens in Penpot (login), via MCP, or through a ticket"
          >
            Edit in Penpot <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <span className="text-muted-foreground">
          {boards.length} board{boards.length === 1 ? "" : "s"} · {doc.objectCount ?? "?"} objects ·{" "}
          {Object.keys(nav).length} links
        </span>
      </div>

      {active && doc.fileId && (
        <BoardCanvas
          fileId={doc.fileId}
          board={active}
          nav={nav}
          onNavigate={(dest) => {
            if (boards.some((b) => b.id === dest)) setBoardId(dest);
          }}
        />
      )}

      <div className="flex gap-3 overflow-x-auto pb-1">
        {boards.map((b) => (
          <BoardThumb
            key={b.id}
            board={b}
            fileId={doc.fileId ?? null}
            active={b.id === active?.id}
            onOpen={() => setBoardId(b.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** Inlines the board SVG and turns Penpot's `<g id="shape-...">` wrappers into
 *  real click targets using the archive's nav map. */
function BoardCanvas({
  fileId,
  board,
  nav,
  onNavigate,
}: {
  fileId: string;
  board: { id: string; name: string; pageId: string };
  nav: Record<string, string>;
  onNavigate: (destination: string) => void;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);
    fetch(`/api/design/board.svg?fileId=${fileId}&pageId=${board.pageId}&boardId=${board.id}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`render failed (${r.status})`))))
      .then((t) => !cancelled && setSvg(t))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [fileId, board.pageId, board.id]);

  // Mark linked shapes so they look clickable; the click itself is delegated.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !svg) return;
    host.querySelectorAll("svg").forEach((el) => {
      el.setAttribute("width", "100%");
      el.removeAttribute("height");
      el.style.display = "block";
    });
    for (const shapeId of Object.keys(nav)) {
      const el = host.querySelector(`#shape-${CSS.escape(shapeId)}`);
      if (el instanceof SVGElement) el.style.cursor = "pointer";
    }
  }, [svg, nav]);

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = (e.target as Element | null)?.closest?.('[id^="shape-"]');
    let node: Element | null = el ?? null;
    while (node) {
      const id = node.getAttribute("id")?.replace(/^shape-/, "");
      if (id && nav[id]) {
        onNavigate(nav[id]);
        return;
      }
      node = node.parentElement?.closest?.('[id^="shape-"]') ?? null;
    }
  };

  if (error) {
    return (
      <p className="rounded-md border border-border bg-muted/20 p-3 text-xs text-amber-700 dark:text-amber-400">
        Could not render this board: {error}. The committed file is still the source of truth — the
        live Penpot instance renders it (compose profile &quot;design&quot;).
      </p>
    );
  }
  if (!svg) {
    return <div className="aspect-[3/2] w-full animate-pulse rounded-md border border-border bg-muted/20" />;
  }
  return (
    <div
      ref={hostRef}
      onClick={onClick}
      className="overflow-hidden rounded-md border border-border bg-black"
      // Sanitized server-side (scripts/handlers stripped) before it reaches here.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function BoardThumb({
  board,
  fileId,
  active,
  onOpen,
}: {
  board: { id: string; name: string; pageId: string };
  fileId: string | null;
  active: boolean;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const src = fileId
    ? `/api/design/board.png?fileId=${fileId}&pageId=${board.pageId}&boardId=${board.id}`
    : null;
  const body =
    src && !failed ? (
      /* No loading="lazy": zero-height images never intersect the viewport, so
         lazy-loading deadlocks (no request → no height → no request; verified
         via DOM inspection: complete=false, naturalWidth=0, zero fetches).
         aspect-[3/2] reserves the box; object-contain keeps the render whole. */
      <img
        src={src}
        alt={board.name}
        onError={() => setFailed(true)}
        className="aspect-[3/2] w-full rounded-md border border-border bg-muted/20 object-contain"
      />
    ) : (
      <div className="flex h-24 items-center justify-center rounded-md border border-border bg-muted/20">
        <Badge variant="default">{board.name}</Badge>
      </div>
    );
  return (
    <figure className="w-44 shrink-0 space-y-1">
      {/* Click steers the INLINE viewer (new tabs only via "Full screen") */}
      <button
        type="button"
        onClick={onOpen}
        title={`Preview ${board.name} inline`}
        className={`block w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          active ? "ring-2 ring-ring" : ""
        }`}
      >
        {body}
      </button>
      <figcaption className="truncate text-[11px] text-muted-foreground">{board.name}</figcaption>
    </figure>
  );
}

export function Design() {
  const { selectedCompanyId } = useCompany();
  const [selected, setSelected] = useState<DesignFileEntry | null>(null);

  const listings = useQuery({
    queryKey: ["design", "files", selectedCompanyId],
    queryFn: () => designApi.files(selectedCompanyId ?? undefined),
    enabled: !!selectedCompanyId,
    refetchInterval: 60_000,
    staleTime: 45_000,
    placeholderData: (prev) => prev,
  });

  // A single document is the common case today — open it without a click.
  const allFiles = (listings.data ?? []).flatMap((r) => r.files);
  const onlyFile = allFiles.length === 1 ? allFiles[0] : null;
  useEffect(() => {
    if (!selected && onlyFile) setSelected(onlyFile);
  }, [selected, onlyFile]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to see its designs.</div>;
  }

  const rows = listings.data ?? [];
  const totalFiles = rows.reduce((n, r) => n + r.files.length, 0);
  // Declutter: only repos with documents (or errors worth surfacing) get a
  // row; empty scans collapse into one summary line.
  const shownRows = rows.filter((r) => r.files.length > 0 || r.error);
  const emptyRepoCount = rows.length - shownRows.length;

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Design</h1>
        <p className="text-sm text-muted-foreground">
          Design-as-code for this company — .penpot exports discovered across its bound repos.
          Draft = open PR; approved = merged. Authoring happens in Penpot.
        </p>
      </div>

      {/* One surface, no side-by-side cards: a document dropdown replaces
          the old Documents panel — a widget's worth of chrome for what is
          usually one file. Errors still surface, empties collapse to a count. */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {listings.isLoading ? (
          <span className="text-muted-foreground">Scanning bound repos…</span>
        ) : allFiles.length > 1 ? (
          <select
            value={selected ? `${selected.repo}::${selected.path}` : ""}
            onChange={(e) => {
              const f = allFiles.find((x) => `${x.repo}::${x.path}` === e.target.value) ?? null;
              setSelected(f);
            }}
            className="h-7 max-w-[24rem] rounded-md border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Select design document"
          >
            {rows
              .filter((r) => r.files.length > 0)
              .map((r) => (
                <optgroup key={r.repo} label={r.repo}>
                  {r.files.map((f) => (
                    <option key={`${f.repo}::${f.path}`} value={`${f.repo}::${f.path}`}>
                      {f.name} · {formatBytes(f.sizeBytes)}
                    </option>
                  ))}
                </optgroup>
              ))}
          </select>
        ) : selected ? (
          <span className="flex items-center gap-2 font-medium">
            <FileJson className="h-3.5 w-3.5 text-muted-foreground" />
            {selected.name}
            <span className="font-normal text-muted-foreground">
              {selected.repo} · {formatBytes(selected.sizeBytes)}
            </span>
          </span>
        ) : null}
        {selected && (
          <a
            href={selected.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            GitHub <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <span className="text-muted-foreground">
          {totalFiles} document{totalFiles === 1 ? "" : "s"}
          {emptyRepoCount > 0 ? ` · ${emptyRepoCount} repo${emptyRepoCount === 1 ? "" : "s"} empty` : ""}
          {rows.some((r) => r.truncated) ? " · listing truncated" : ""}
        </span>
      </div>

      {rows
        .filter((r) => r.error)
        .map((r) => (
          <p key={r.repo} className="text-xs text-rose-600 dark:text-rose-400">
            {r.repo}: {r.error}
          </p>
        ))}

      {listings.isError ? (
        <p className="text-xs text-rose-600 dark:text-rose-400">Failed to scan bound repos.</p>
      ) : totalFiles === 0 && !listings.isLoading && rows.every((r) => !r.error) ? (
        <p className="text-xs text-muted-foreground">
          No design documents yet. Author the first one in Penpot and export it into the
          product's design space (see the design repo's conventions: product/, explorations/).
        </p>
      ) : selected ? (
        <DocumentPreview file={selected} />
      ) : null}
    </div>
  );
}
