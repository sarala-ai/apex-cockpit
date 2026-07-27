// Design — design-as-code for this company. Discovers .penpot exports (and
// legacy .op files) across the company's BOUND repos (placement-agnostic: a
// standalone design repo and an in-repo design/ dir are both just bindings),
// grouped by repo, with a summarized preview (boards + manifest for Penpot
// archives). Read-only surface: authoring happens in Penpot (self-hosted,
// `--profile design`) by hand or via apex-core's penpot resource server;
// review happens in PRs — draft = open PR, approved = merged (git-native
// status, no filename versioning).

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileJson, PenTool } from "lucide-react";
import { designApi } from "@/api/design";
import { useCompany } from "@/context/CompanyContext";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  penpotEditUrl?: string;
  penpotViewUrl?: string;
}

/** Visual preview: page dropdown + rendered board thumbnails (live Penpot
 *  exporter behind /design/board.png). Click a board to play it in Penpot's
 *  view mode. Thumbnails that fail (Penpot down) fall back to a name badge. */
function PenpotPreview({ doc }: { doc: PenpotSummaryDoc }) {
  const pages = doc.pages ?? [];
  const boards = doc.boards ?? [];
  const [pageId, setPageId] = useState<string>(pages[0]?.id ?? "");
  const activePage = pages.find((p) => p.id === pageId) ?? pages[0];
  const pageBoards = boards.filter((b) => b.pageId === (activePage?.id ?? ""));

  const viewUrlFor = (b: { pageId: string }) =>
    doc.penpotViewUrl && doc.fileId
      ? doc.penpotViewUrl.replace(/page-id=[0-9a-f-]+/i, `page-id=${b.pageId}`)
      : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        {pages.length > 1 && (
          <select
            value={activePage?.id ?? ""}
            onChange={(e) => setPageId(e.target.value)}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Select page"
          >
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {doc.penpotViewUrl && (
          <a
            href={doc.penpotViewUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
          >
            Play prototype <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {doc.penpotEditUrl && (
          <a
            href={doc.penpotEditUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            Open in Penpot <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <span className="text-muted-foreground">
          {boards.length} board{boards.length === 1 ? "" : "s"} · {doc.objectCount ?? "?"} objects
        </span>
      </div>
      <div className="grid max-h-[32rem] grid-cols-1 gap-3 overflow-y-auto xl:grid-cols-2">
        {pageBoards.map((b) => (
          <BoardThumb key={b.id} board={b} fileId={doc.fileId ?? null} viewUrl={viewUrlFor(b)} />
        ))}
        {pageBoards.length === 0 && (
          <p className="text-xs text-muted-foreground">No boards on this page.</p>
        )}
      </div>
    </div>
  );
}

function BoardThumb({
  board,
  fileId,
  viewUrl,
}: {
  board: { id: string; name: string; pageId: string };
  fileId: string | null;
  viewUrl: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const src = fileId
    ? `/api/design/board.png?fileId=${fileId}&pageId=${board.pageId}&boardId=${board.id}`
    : null;
  const body =
    src && !failed ? (
      <img
        src={src}
        alt={board.name}
        loading="lazy"
        onError={() => setFailed(true)}
        className="w-full rounded-md border border-border bg-muted/20"
      />
    ) : (
      <div className="flex h-24 items-center justify-center rounded-md border border-border bg-muted/20">
        <Badge variant="default">{board.name}</Badge>
      </div>
    );
  return (
    <figure className="space-y-1">
      {viewUrl ? (
        <a href={viewUrl} target="_blank" rel="noreferrer" title={`Open ${board.name} in Penpot view mode`}>
          {body}
        </a>
      ) : (
        body
      )}
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <PenTool className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Documents</CardTitle>
          </CardHeader>
          <CardContent>
            {listings.isLoading ? (
              <p className="text-xs text-muted-foreground">Scanning bound repos…</p>
            ) : listings.isError ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">Failed to scan bound repos.</p>
            ) : rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No repos bound to this company yet — bind them in Company Settings → Cloud.
              </p>
            ) : (
              <div className="space-y-3">
                {shownRows.map((r) => (
                  <div key={r.repo} className="space-y-1.5">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono font-medium">{r.repo}</span>
                      {r.error ? (
                        <span className="text-rose-600 dark:text-rose-400">— {r.error}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          {r.files.length} document{r.files.length === 1 ? "" : "s"}
                          {r.truncated ? " (listing truncated)" : ""}
                        </span>
                      )}
                    </div>
                    {r.files.length > 0 && (
                      <ul className="space-y-1 pl-1">
                        {r.files.map((f) => (
                          <li
                            key={`${f.repo}:${f.path}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => setSelected(f)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelected(f);
                              }
                            }}
                            className={`flex cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                              selected && selected.repo === f.repo && selected.path === f.path
                                ? "bg-accent text-accent-foreground"
                                : ""
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <FileJson className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="truncate font-medium" title={f.path}>
                                {f.name}
                              </span>
                              <span className="truncate text-muted-foreground">{f.path}</span>
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {formatBytes(f.sizeBytes)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
                {emptyRepoCount > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    {emptyRepoCount} bound repo{emptyRepoCount === 1 ? "" : "s"} with no design
                    documents.
                  </p>
                )}
                {totalFiles === 0 && rows.every((r) => !r.error) && (
                  <p className="text-xs text-muted-foreground">
                    No design documents yet. Author the first one in Penpot and export it into
                    the product's design space (see the design repo's conventions: product/,
                    explorations/).
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="flex min-w-0 items-center gap-2 text-base">
              <FileJson className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{selected ? selected.name : "Document"}</span>
            </CardTitle>
            {selected && (
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer"
                className="flex shrink-0 items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
              >
                GitHub <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </CardHeader>
          <CardContent>
            {selected ? (
              <DocumentPreview file={selected} />
            ) : (
              <p className="text-xs text-muted-foreground">Select a document to preview it.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
