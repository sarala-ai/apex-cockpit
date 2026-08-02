/**
 * PROPOSAL REVIEW — the surface the whole redirect exists for.
 *
 * One screen: the records as a grid with provenance per row, corrections made
 * in place, and ONE decision at the bottom. Approving materialises the records
 * onto the board; requesting changes sends the set back to the agent that
 * proposed it, with the reason attached, through the approval routing that
 * already exists.
 *
 * This page resolves its columns through the renderer registry and never names
 * a kind.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ProposalColumn, ProposalRecord } from "@paperclipai/shared";
import { proposalsApi } from "../api/proposals";
import { approvalsApi } from "../api/approvals";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { ProposalGrid } from "../components/ProposalGrid";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { resolveProposalRenderer } from "../components/proposal-renderers";
import { fallbackColumnsFor } from "../components/proposal-renderers/FallbackRenderer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileSpreadsheet, Inbox } from "lucide-react";

const DECIDED = new Set(["approved", "rejected"]);

export function ProposalReview() {
  const { proposalId } = useParams<{ proposalId: string }>();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [savingRefs, setSavingRefs] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: proposal, isLoading, error } = useQuery({
    queryKey: ["proposals", "detail", proposalId],
    queryFn: () => proposalsApi.get(proposalId!),
    enabled: !!proposalId,
  });

  const { data: kinds } = useQuery({
    queryKey: ["proposal-kinds"],
    queryFn: () => proposalsApi.kinds(),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Proposals", href: "/proposals" },
      { label: proposal?.title ?? "Review" },
    ]);
  }, [setBreadcrumbs, proposal?.title]);

  const records = useMemo(
    () => ((proposal?.records ?? []) as ProposalRecord[]),
    [proposal?.records],
  );

  /**
   * Columns come from the SERVER's declaration when it has one — a kind is
   * single-sourced, and the client registry is the rendering half of the same
   * declaration, not a second copy of the truth. Falling through: the local
   * renderer, then derived-from-records, so an unknown kind is still readable.
   */
  const columns: readonly ProposalColumn[] = useMemo(() => {
    if (!proposal) return [];
    const served = kinds?.find((entry) => entry.kind === proposal.kind);
    if (served?.columns?.length) return served.columns;
    const renderer = resolveProposalRenderer({ kind: proposal.kind, records });
    if (renderer.columns.length) return renderer.columns;
    return fallbackColumnsFor(records);
  }, [proposal, kinds, records]);

  const correct = useMutation({
    mutationFn: ({ ref, patch }: { ref: string; patch: Record<string, unknown> }) =>
      proposalsApi.correctRecord(proposalId!, ref, patch),
    onMutate: ({ ref }) => setSavingRefs((current) => [...current, ref]),
    onSuccess: (result, { ref }) => {
      setFieldErrors((current) => ({ ...current, [ref]: result.fieldsError }));
      queryClient.setQueryData(["proposals", "detail", proposalId], result.proposal);
    },
    onError: (err: Error, { ref }) =>
      setFieldErrors((current) => ({ ...current, [ref]: err.message })),
    onSettled: (_data, _err, { ref }) =>
      setSavingRefs((current) => current.filter((entry) => entry !== ref)),
  });

  const decide = useMutation({
    mutationFn: async (decision: "approve" | "request_changes") => {
      if (!proposal?.approvalId) throw new Error("This proposal has not been submitted to a gate.");
      if (decision === "approve") return approvalsApi.approve(proposal.approvalId, reason || undefined);
      return approvalsApi.requestRevision(proposal.approvalId, reason);
    },
    onSuccess: () => {
      setReason("");
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["proposals", "detail", proposalId] });
      // Approval materialises goals; the goals list is now stale.
      void queryClient.invalidateQueries({ queryKey: ["goals"] });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  const submit = useMutation({
    mutationFn: () => proposalsApi.submit(proposalId!),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ["proposals", "detail", proposalId] });
    },
    onError: (err: Error) => setActionError(err.message),
  });

  if (isLoading) return <PageSkeleton variant="list" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!proposal) {
    return <EmptyState icon={Inbox} message="Proposal not found." />;
  }

  const decided = DECIDED.has(proposal.status);
  const editable = !decided;
  const live = records.filter((record) => !record.excluded);
  const inferred = live.filter((record) => record.provenance.kind === "inferred").length;
  const updates = live.filter((record) => record.targetId).length;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">{proposal.title}</h1>
          {proposal.summary && (
            <p className="text-sm text-muted-foreground mt-1">{proposal.summary}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Badge variant="secondary">{proposal.kind}</Badge>
            <Badge variant="outline">{proposal.status}</Badge>
            {/* Said up front, because it is what the reviewer is deciding:
                how many rows are reconstructions rather than record. */}
            <span className="text-xs text-muted-foreground">
              {live.length} record{live.length === 1 ? "" : "s"} · {updates} update
              {updates === 1 ? "" : "s"} · {live.length - updates} create
              {live.length - updates === 1 ? "" : "s"} · {inferred} inferred
            </span>
          </div>
        </div>
        <Button size="sm" variant="outline" asChild>
          <a href={proposalsApi.exportCsvUrl(proposal.id)} download>
            <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
            Export CSV
          </a>
        </Button>
      </div>

      <ProposalGrid
        columns={columns}
        records={records}
        editable={editable}
        savingRefs={savingRefs}
        fieldErrors={fieldErrors}
        onCorrect={(ref, patch) => correct.mutate({ ref, patch })}
      />

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {proposal.status === "approved" && proposal.materialization && (
        <div className="text-sm border rounded-md p-3" data-testid="materialization-result">
          <p className="font-medium">Materialised</p>
          <p className="text-muted-foreground">
            {proposal.materialization.created.length} created ·{" "}
            {proposal.materialization.updated.length} updated ·{" "}
            {proposal.materialization.skipped.length} skipped
          </p>
          {proposal.materialization.errors.length > 0 && (
            <ul className="mt-1 text-destructive">
              {proposal.materialization.errors.map((entry) => (
                <li key={entry.ref}>
                  {entry.ref}: {entry.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!decided && (
        <div className="space-y-2 border rounded-md p-3">
          {/* ONE gate over the whole set. The reason box is shared because a
              request for changes needs one and an approval may carry one. */}
          <Textarea
            aria-label="Decision note"
            placeholder="Reason — required when requesting changes; it goes back to the proposing agent verbatim."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="flex items-center gap-2">
            {proposal.approvalId ? (
              <>
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate("approve")}
                >
                  Approve &amp; materialise
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={decide.isPending || reason.trim().length === 0}
                  onClick={() => decide.mutate("request_changes")}
                >
                  Request changes
                </Button>
                <span className="text-xs text-muted-foreground">
                  Nothing exists on the board until this is approved.
                </span>
              </>
            ) : (
              <>
                <Button size="sm" disabled={submit.isPending} onClick={() => submit.mutate()}>
                  Send to gate
                </Button>
                <span className="text-xs text-muted-foreground">
                  Corrections are saved on the proposal. Sending it to the gate opens the single
                  approval over the whole set.
                </span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
