import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { goalsApi } from "../api/goals";
import { builtInAgentsApi } from "../api/builtInAgents";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { GoalHierarchyList } from "../components/GoalHierarchyList";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Target, Plus, FileSpreadsheet, History } from "lucide-react";

/**
 * The brownfield entry point.
 *
 * A company whose product predates this board arrives with years of shipped
 * work and nothing on the Goals page, and until now the only offer was "Add
 * Goal" — one initiative at a time, typed from memory. That is how a board gets
 * abandoned rather than populated: people correct fluently and create
 * reluctantly.
 *
 * So there is a second route, and it is deliberately NOT an import. It
 * commissions the Product Assistant's reconstruction routine, which reads the
 * repositories, the specs and the board's own history and comes back with a
 * PROPOSAL — records carrying their provenance, correctable in a grid, gated
 * once. The label says "review", the footnote says nothing is written, and the
 * toast says a proposal is coming, because a bulk route that reads as an import
 * is exactly the promise this product cannot keep: intent is not recoverable
 * from a commit log, and the reconstruction has to arrive as a draft to be
 * corrected, never as a fact.
 */
const RECONSTRUCTION_AGENT_KEY = "product-assistant";
const RECONSTRUCTION_ROUTINE_KEY = "reconstruct-initiatives";

export function Goals() {
  const { selectedCompanyId } = useCompany();
  const { openNewGoal } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();

  useEffect(() => {
    setBreadcrumbs([{ label: "Goals" }]);
  }, [setBreadcrumbs]);

  const { data: goals, isLoading, error } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const reconstruct = useMutation({
    mutationFn: () =>
      builtInAgentsApi.runRoutine(
        selectedCompanyId!,
        RECONSTRUCTION_AGENT_KEY,
        RECONSTRUCTION_ROUTINE_KEY,
      ),
    onSuccess: (run) => {
      const issueId = (run as { linkedIssueId?: string | null } | null)?.linkedIssueId ?? null;
      pushToast({
        title: "Reconstruction started",
        body:
          "The Product Assistant is reading the repositories and this board's history. "
          + "It will submit a proposal for you to review — nothing is written to the board until you approve it.",
        tone: "info",
        ...(issueId ? { action: { label: "Follow the run", href: `/issues/${issueId}` } } : {}),
      });
    },
    onError: (mutationError) => {
      pushToast({
        title: "Could not start the reconstruction",
        body: mutationError instanceof Error ? mutationError.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Target} message="Select a company to view goals." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {goals && goals.length === 0 && (
        <EmptyState
          icon={Target}
          message="No goals yet."
          action="Add Goal"
          onAction={() => openNewGoal()}
          secondaryAction="Reconstruct from the repos"
          onSecondaryAction={() => reconstruct.mutate()}
          secondaryActionPending={reconstruct.isPending}
          footnote="Already shipped work before this board existed? The Product Assistant reads the repositories, the specs and this board's history and proposes the initiatives it can evidence — marked confirmed or inferred, for you to correct and approve. It writes nothing on its own."
        />
      )}

      {goals && goals.length > 0 && (
        <>
          <div className="flex items-center justify-start gap-2">
            <Button size="sm" variant="outline" onClick={() => openNewGoal()}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Goal
            </Button>
            {/* Reachable with a populated board too, not only from the empty
                state: the realistic brownfield case is a board that already has
                rows a script or a person put there, and the reconstruction
                proposes UPDATES to those rather than duplicates of them. */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => reconstruct.mutate()}
              disabled={reconstruct.isPending}
            >
              <History className="h-3.5 w-3.5 mr-1.5" />
              {reconstruct.isPending ? "Starting…" : "Reconstruct from the repos"}
            </Button>
            {/* Offline scanning, not review. Reviewing a set of records is what
                a proposal is for — it shows provenance per row, takes
                corrections in place, and gates them once. This button is for
                reading 26 rows somewhere a browser is not. */}
            <Button size="sm" variant="outline" asChild>
              <a
                href={`/api/companies/${selectedCompanyId}/goals/export.csv?level=initiative`}
                download
              >
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
                Export initiatives (CSV)
              </a>
            </Button>
          </div>
          <GoalHierarchyList goals={goals} goalLink={(goal) => `/goals/${goal.id}`} />
        </>
      )}
    </div>
  );
}
