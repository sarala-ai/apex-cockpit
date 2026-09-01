// Release detail — what this release carried, grouped by the initiative each
// change serves, the repository tags that are the evidence, and the generated
// notes. The confound statement sits at the top, before anything a reader might
// mistake for clean evidence.

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import type { ReleaseChange } from "@paperclipai/shared";
import { releasesApi } from "../api/releases";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { ConfoundWarning } from "../components/ConfoundWarning";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link, useParams } from "@/lib/router";
import { observationWindowOpen } from "./Releases";

function formatDate(value: string | Date | null): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}

type Group = { initiativeId: string | null; initiativeTitle: string | null; changes: ReleaseChange[] };

function groupByInitiative(changes: ReleaseChange[]): Group[] {
  const groups = new Map<string, Group>();
  for (const change of changes) {
    const key = change.initiativeId ?? "__unattributed__";
    const group = groups.get(key) ?? {
      initiativeId: change.initiativeId,
      initiativeTitle: change.initiativeTitle,
      changes: [],
    };
    group.changes.push(change);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function ReleaseDetail() {
  const { releaseId } = useParams<{ releaseId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.releases.detail(releaseId!),
    queryFn: () => releasesApi.detail(releaseId!),
    enabled: !!releaseId,
  });

  const notesQuery = useQuery({
    queryKey: queryKeys.releases.notes(releaseId!),
    queryFn: () => releasesApi.notes(releaseId!),
    enabled: !!releaseId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Releases", href: "/releases" },
      { label: data?.release.version ?? "Release" },
    ]);
  }, [setBreadcrumbs, data?.release.version]);

  const groups = useMemo(() => groupByInitiative(data?.changes ?? []), [data?.changes]);

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!data) return <EmptyState icon={Rocket} message="Release not found." />;

  const { release, artifacts, confounds, promotedFrom, promotedTo } = data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold">{release.version}</h1>
        {release.name && <span className="text-sm text-muted-foreground">{release.name}</span>}
        <Badge variant="outline">{release.environment}</Badge>
        <StatusBadge status={release.status} />
        {release.closure && <StatusBadge status={release.closure} />}
      </div>

      {/* The confound statement comes FIRST: it qualifies everything below it. */}
      <ConfoundWarning confounds={confounds} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Measurement window</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">Released</span>
              <span className="text-sm">{formatDate(release.releasedAt)}</span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-xs text-muted-foreground">Window ends</span>
              <span className="text-sm">
                {formatDate(release.observationWindowEndsAt)}
                {observationWindowOpen(release) && (
                  <span className="ml-2 text-xs text-sky-500" data-testid="observation-open">
                    open
                  </span>
                )}
              </span>
            </div>
            {release.closure && (
              <div className="flex items-start justify-between py-1.5">
                <span className="text-xs text-muted-foreground">Closed</span>
                <span className="max-w-[60%] text-right text-sm">
                  {release.closure}
                  {release.closureReason && (
                    <span className="block text-xs text-muted-foreground">
                      {release.closureReason}
                    </span>
                  )}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Artifacts</CardTitle>
          </CardHeader>
          <CardContent>
            {artifacts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No repository tags recorded. The tag is the evidence a release aggregates.
              </p>
            ) : (
              <ul className="space-y-1">
                {artifacts.map((artifact) => (
                  <li key={artifact.id} className="font-mono text-xs" data-testid="release-artifact">
                    {artifact.repo} <span className="text-muted-foreground">{artifact.tag}</span>
                    {artifact.commitSha && (
                      <span className="ml-1 text-muted-foreground">
                        @ {artifact.commitSha.slice(0, 12)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {(promotedFrom || promotedTo.length > 0) && (
              <div className="mt-3 space-y-1 border-t border-border pt-2">
                {promotedFrom && (
                  <p className="text-xs text-muted-foreground">
                    Promoted from{" "}
                    <Link to={`/releases/${promotedFrom.id}`} className="hover:underline">
                      {promotedFrom.version} ({promotedFrom.environment})
                    </Link>
                  </p>
                )}
                {promotedTo.map((next) => (
                  <p key={next.id} className="text-xs text-muted-foreground">
                    Promoted to{" "}
                    <Link to={`/releases/${next.id}`} className="hover:underline">
                      {next.version} ({next.environment})
                    </Link>
                  </p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Changes</CardTitle>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <p className="text-xs text-muted-foreground">No changes recorded against this release.</p>
          ) : (
            <div className="space-y-3">
              {groups.map((group) => (
                <div key={group.initiativeId ?? "unattributed"} data-testid="initiative-group">
                  <div className="flex items-center gap-2 rounded-t-md bg-muted/50 px-3 py-1.5">
                    <span className="text-sm font-medium">
                      {group.initiativeTitle ?? "Unattributed"}
                    </span>
                    <span className="ml-1 text-xs text-muted-foreground">
                      {group.changes.length}
                    </span>
                  </div>
                  <ul className="rounded-b-md border border-border">
                    {group.changes.map((change) => (
                      <li
                        key={change.issueId}
                        className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 last:border-b-0"
                      >
                        {change.identifier && (
                          <span className="font-mono text-xs text-muted-foreground">
                            {change.identifier}
                          </span>
                        )}
                        <span className="text-sm">{change.title}</span>
                        {change.pullRequests.map((pr) =>
                          pr.url ? (
                            <a
                              key={pr.id}
                              href={pr.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-muted-foreground hover:underline"
                            >
                              PR
                            </a>
                          ) : null,
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">
            Release notes
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              generated from the provenance record — never hand-authored
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {notesQuery.isLoading && <p className="text-xs text-muted-foreground">Loading notes…</p>}
          {notesQuery.isError && (
            <p className="text-xs text-destructive">Failed to load release notes.</p>
          )}
          {notesQuery.data && (
            <pre
              className="overflow-x-auto rounded-lg bg-neutral-950 p-3 font-mono text-xs whitespace-pre-wrap text-neutral-100"
              data-testid="release-notes"
            >
              {notesQuery.data.markdown}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
