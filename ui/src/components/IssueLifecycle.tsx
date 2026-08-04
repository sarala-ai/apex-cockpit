/**
 * Where a ticket is in its lifecycle, and whether it needs a person right now.
 *
 * A ticket used to say nothing about this. To learn that a process had stopped
 * and was waiting on YOU, you had to know pipelines existed, find the right
 * board, and spot the card in a column. The ticket is where a person looks, so
 * the ticket is where the answer belongs.
 *
 * Two shapes, deliberately very different in weight:
 *
 *   - nothing is waiting  — one quiet sentence saying which process the ticket
 *                           is on and where it has got to.
 *   - a decision is due   — a gate the eye cannot skip, carrying the question
 *                           the process actually asked and the decisions it
 *                           actually offers, answerable here.
 *
 * The decisions are never assumed: they come from the stage's own settings via
 * `reviewDecisionActions`, the same derivation the pipeline board uses. A gate
 * that declares no "request changes" target genuinely has none, and offering
 * the button anyway would be offering a decision the server refuses.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Issue, IssueLinkedCase } from "@paperclipai/shared";
import type { PipelineReviewDecision } from "../api/pipelines";
import {
  describeGateApprover,
  describeIssueLifecyclePosition,
  issueLifecycleCaseHref,
  selectIssueLifecycleCase,
} from "../lib/issue-lifecycle";
import { reviewDecisionActions, reviewDecisionConfigFromStageConfig } from "../lib/review-decision";

export function IssueLifecycle({
  issue,
  onDecide,
  deciding,
  resolveUserLabel,
}: {
  issue: Pick<Issue, "linkedCases"> | null | undefined;
  /** Submits the decision. Absent means this surface can only point at the
   *  gate, never answer it. */
  onDecide?: (input: { row: IssueLinkedCase; decision: PipelineReviewDecision; reason: string | null }) => void;
  deciding?: PipelineReviewDecision | null;
  resolveUserLabel?: (userId: string) => string | null;
}) {
  const row = selectIssueLifecycleCase(issue);
  if (!row) return null;
  if (row.review) {
    return (
      <IssueLifecycleGate
        row={row}
        review={row.review}
        onDecide={onDecide}
        deciding={deciding ?? null}
        resolveUserLabel={resolveUserLabel}
      />
    );
  }
  return <IssueLifecyclePosition row={row} />;
}

function IssueLifecyclePosition({ row }: { row: IssueLinkedCase }) {
  const { prefix, stageName, suffix } = describeIssueLifecyclePosition(row);
  return (
    <p className="text-sm text-muted-foreground" data-testid="issue-lifecycle-position">
      {prefix}
      <Link
        to={issueLifecycleCaseHref(row)}
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        {stageName}
      </Link>
      {suffix}
    </p>
  );
}

function IssueLifecycleGate({
  row,
  review,
  onDecide,
  deciding,
  resolveUserLabel,
}: {
  row: IssueLinkedCase;
  review: NonNullable<IssueLinkedCase["review"]>;
  onDecide?: (input: { row: IssueLinkedCase; decision: PipelineReviewDecision; reason: string | null }) => void;
  deciding: PipelineReviewDecision | null;
  resolveUserLabel?: (userId: string) => string | null;
}) {
  const [reason, setReason] = useState("");
  // The pipeline's OWN names for the stages a decision moves to, so
  // "Reject → Cancelled" reads here exactly as it does on the board.
  const actions = reviewDecisionActions(
    reviewDecisionConfigFromStageConfig(review.config),
    new Map(Object.entries(review.stageNames ?? {})),
  );
  const trimmedReason = reason.trim();
  const pending = deciding !== null;
  const canDecideHere = Boolean(onDecide) && actions.length > 0;
  const gateHref = issueLifecycleCaseHref(row);

  return (
    <section
      data-testid="issue-lifecycle-gate"
      className="border-y border-amber-300 bg-amber-50/70 p-4 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-base font-semibold leading-tight">
              Waiting for a decision before this goes any further
            </p>
            <p className="mt-1 text-sm opacity-80">
              The {row.pipeline.name} process has stopped at {row.stage.name}.{" "}
              {describeGateApprover(review.config, resolveUserLabel)}
            </p>
          </div>

          {review.question ? (
            <p className="text-sm font-medium" data-testid="issue-lifecycle-gate-question">
              {review.question}
            </p>
          ) : null}

          {canDecideHere ? (
            <div className="space-y-3">
              <label className="block space-y-1.5 text-sm font-medium">
                <span>Reason</span>
                <Textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  rows={3}
                  placeholder={
                    actions.some((action) => action.requireReason)
                      ? "Required to send this back or stop it."
                      : "Optional note."
                  }
                  className="bg-background/90 text-foreground"
                />
              </label>

              <div className="flex flex-wrap gap-2">
                {actions.map((action) => {
                  const reasonMissing = action.requireReason && trimmedReason.length === 0;
                  const isPendingAction = deciding === action.decision;
                  return (
                    <Button
                      key={action.decision}
                      type="button"
                      size="sm"
                      variant={action.variant}
                      aria-label={`${action.label} and move to ${action.targetStageName}`}
                      disabled={pending || reasonMissing}
                      onClick={() =>
                        onDecide?.({ row, decision: action.decision, reason: trimmedReason || null })
                      }
                    >
                      {isPendingAction ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : action.decision === "approve" ? (
                        <Check className="h-4 w-4" aria-hidden />
                      ) : (
                        <X className="h-4 w-4" aria-hidden />
                      )}
                      {action.label}
                      <span className="opacity-75">→ {action.targetStageName}</span>
                    </Button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-sm">
              <Link to={gateHref} className="font-medium underline underline-offset-2">
                Open the decision
              </Link>
            </p>
          )}

          <p className="text-xs opacity-75">
            <Link to={gateHref} className="inline-flex items-center gap-1 underline underline-offset-2">
              See everything this process has done so far
              <ArrowUpRight className="h-3 w-3" aria-hidden />
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
