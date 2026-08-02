// Releases — the second axis. The intent tree (idea → initiative → project →
// task → ticket) decomposes; a release aggregates ACROSS it, because several
// initiatives ship together. This surface exists so the question "what else
// changed at the same time" has an answer.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import type { Release } from "@paperclipai/shared";
import { releasesApi } from "../api/releases";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/router";

function formatDate(value: string | Date | null): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString().slice(0, 10);
}

/** True while the release is still inside the window it will be measured over. */
export function observationWindowOpen(release: Release, now = new Date()): boolean {
  if (!release.releasedAt || release.closure) return false;
  if (!release.observationWindowEndsAt) return false;
  return new Date(release.observationWindowEndsAt).getTime() > now.getTime();
}

export function Releases() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Releases" }]);
  }, [setBreadcrumbs]);

  const {
    data: releases,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.releases.list(selectedCompanyId!),
    queryFn: () => releasesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Rocket} message="Select a product to view its releases." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {releases && releases.length === 0 && (
        <EmptyState
          icon={Rocket}
          title="No releases yet"
          message="A release is the measurement boundary for this product — the record of what shipped together, so a metric movement can be attributed to the initiative that caused it."
        />
      )}

      {releases && releases.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3 text-xs font-medium text-muted-foreground">Version</th>
                <th className="py-2 pr-3 text-xs font-medium text-muted-foreground">Environment</th>
                <th className="py-2 pr-3 text-xs font-medium text-muted-foreground">Status</th>
                <th className="py-2 pr-3 text-xs font-medium text-muted-foreground">Released</th>
                <th className="py-2 pr-3 text-xs font-medium text-muted-foreground">
                  Observation window
                </th>
              </tr>
            </thead>
            <tbody>
              {releases.map((release) => (
                <tr
                  key={release.id}
                  className="border-b border-border/60 hover:bg-accent/50"
                  data-testid="release-row"
                >
                  <td className="py-2 pr-3">
                    <Link
                      to={`/releases/${release.id}`}
                      className="font-medium hover:underline"
                    >
                      {release.version}
                    </Link>
                    {release.name && (
                      <span className="ml-2 text-xs text-muted-foreground">{release.name}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <Badge variant="outline">{release.environment}</Badge>
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={release.status} />
                      {release.closure && <StatusBadge status={release.closure} />}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {formatDate(release.releasedAt)}
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {observationWindowOpen(release) ? (
                      <span className="text-sky-500" data-testid="observation-open">
                        open until {formatDate(release.observationWindowEndsAt)}
                      </span>
                    ) : release.observationWindowEndsAt ? (
                      `closed ${formatDate(release.observationWindowEndsAt)}`
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
