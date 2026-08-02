/**
 * The list of proposals awaiting (or past) review. Deliberately thin — the work
 * happens on the review surface; this is only the way in.
 */
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { ProposalRecord } from "@paperclipai/shared";
import { proposalsApi } from "../api/proposals";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Badge } from "@/components/ui/badge";
import { ClipboardList } from "lucide-react";

export function Proposals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Proposals" }]);
  }, [setBreadcrumbs]);

  const { data: proposals, isLoading, error } = useQuery({
    queryKey: ["proposals", selectedCompanyId],
    queryFn: () => proposalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ClipboardList} message="Select a company to view proposals." />;
  }
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {proposals && proposals.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          message="No proposals yet. An agent proposing a set of records opens one here."
        />
      )}
      {proposals && proposals.length > 0 && (
        <ul className="divide-y border rounded-md" data-testid="proposal-list">
          {proposals.map((proposal) => {
            const records = (proposal.records ?? []) as ProposalRecord[];
            const live = records.filter((record) => !record.excluded);
            const inferred = live.filter((r) => r.provenance.kind === "inferred").length;
            return (
              <li key={proposal.id} className="p-3">
                <Link to={`/proposals/${proposal.id}`} className="font-medium hover:underline">
                  {proposal.title}
                </Link>
                <div className="flex flex-wrap items-center gap-2 mt-1">
                  <Badge variant="secondary">{proposal.kind}</Badge>
                  <Badge variant="outline">{proposal.status}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {live.length} record{live.length === 1 ? "" : "s"} · {inferred} inferred
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
