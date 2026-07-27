// Design — design-as-code for this company. Discovers .penpot exports (and
// legacy .op files) across the company's BOUND repos (placement-agnostic: a
// standalone design repo and an in-repo design/ dir are both just bindings),
// grouped by repo, with a summarized preview (boards + manifest for Penpot
// archives). Read-only surface: authoring happens in Penpot (self-hosted,
// `--profile design`) by hand or via apex-core's penpot resource server;
// review happens in PRs — draft = open PR, approved = merged (git-native
// status, no filename versioning).

import { useState } from "react";
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
  const boards = isPenpot
    ? ((d as { boards?: { id: string; name: string }[] }).boards ?? [])
    : [];
  const editUrl = isPenpot ? ((d as { penpotEditUrl?: string }).penpotEditUrl ?? null) : null;
  const viewUrl = isPenpot ? ((d as { penpotViewUrl?: string }).penpotViewUrl ?? null) : null;
  const topKeys = d && typeof d === "object" && !Array.isArray(d) ? Object.keys(d as object) : [];
  return (
    <div className="space-y-2">
      {isPenpot ? (
        <div className="space-y-2">
          {(editUrl || viewUrl) && (
            <div className="flex items-center gap-3 text-xs">
              {viewUrl && (
                <a
                  href={viewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
                >
                  Play prototype <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {editUrl && (
                <a
                  href={editUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                >
                  Open in Penpot <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {boards.map((b) => (
              <Badge key={b.id} variant="default">
                {b.name}
              </Badge>
            ))}
            <span className="self-center text-[11px] text-muted-foreground">
              {boards.length} board{boards.length === 1 ? "" : "s"} ·{" "}
              {(d as { objectCount?: number }).objectCount ?? "?"} objects
            </span>
          </div>
        </div>
      ) : (
        topKeys.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {topKeys.slice(0, 12).map((k) => (
              <Badge key={k} variant="default">
                {k}
              </Badge>
            ))}
          </div>
        )
      )}
      <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] leading-relaxed">
        {JSON.stringify(d, null, 2)?.slice(0, 20_000)}
      </pre>
    </div>
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

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to see its designs.</div>;
  }

  const rows = listings.data ?? [];
  const totalFiles = rows.reduce((n, r) => n + r.files.length, 0);

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
                {rows.map((r) => (
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
                {totalFiles === 0 && rows.every((r) => !r.error) && (
                  <p className="text-xs text-muted-foreground">
                    No design documents yet. Author the first one in Penpot and export it into
                    the product's design space (see the design repo's conventions: product/,
                    components/, explorations/).
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
