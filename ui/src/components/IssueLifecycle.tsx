/**
 * Where a ticket is in its lifecycle, and whether it needs a person right now.
 *
 * A ticket used to say nothing about this. To learn that a process had stopped
 * and was waiting on YOU, you had to know pipelines existed, find the right
 * board, and spot the card in a column. The ticket is where a person looks, so
 * the ticket is where the answer belongs.
 *
 * Three shapes, deliberately very different in weight:
 *
 *   - nothing is waiting  — one quiet sentence saying which process the ticket
 *                           is on and where it has got to.
 *   - a decision is due   — a gate the eye cannot skip, carrying the question
 *                           the process actually asked and the decisions it
 *                           actually offers, answerable here.
 *   - a step has stopped  — the same weight as a gate, because it is the same
 *                           class of signal: the process is not going to move
 *                           on by itself. Carries the reason the server
 *                           recorded and what a person can do about it. Not
 *                           answerable here — the fix lives at the item — so
 *                           it points there rather than pretending otherwise.
 *
 * The decisions are never assumed: they come from the stage's own settings via
 * `reviewDecisionActions`, the same derivation the pipeline board uses. A gate
 * that declares no "request changes" target genuinely has none, and offering
 * the button anyway would be offering a decision the server refuses.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowUpRight, Check, Loader2, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Issue, IssueLinkedCase } from "@paperclipai/shared";
import type { PipelineReviewDecision } from "../api/pipelines";
import { pipelinesApi } from "../api/pipelines";
import {
  describeGateApprover,
  describeIssueLifecyclePosition,
  issueLifecycleCaseHref,
  selectIssueLifecycleCase,
} from "../lib/issue-lifecycle";
import { reviewDecisionActions, reviewDecisionConfigFromStageConfig } from "../lib/review-decision";
import { describeStepHold } from "../lib/step-hold";
import { GateBrief } from "./GateBrief";

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
  // A pending gate outranks a hold: the gate can be ANSWERED right here, so
  // showing it is strictly more useful than showing a stop the person has to
  // go elsewhere to clear. (In practice the two barely co-occur — a gate is a
  // stage the process is waiting at, a hold is a step that failed.)
  if (row.review) {
    return (
      <IssueLifecycleGate
        row={row}
        review={row.review}
        hold={row.hold ?? null}
        onDecide={onDecide}
        deciding={deciding ?? null}
        resolveUserLabel={resolveUserLabel}
      />
    );
  }
  if (row.hold) return <IssueLifecycleHold row={row} hold={row.hold} />;
  return <IssueLifecyclePosition row={row} />;
}

/**
 * A step that stopped, on the ticket.
 *
 * The regression this closes: the retired flow coordinator posted a
 * plain-language comment on the ticket every time a step paused or failed, so
 * a founder watching the ticket learned that work had stopped and why. The
 * pipeline host records the same facts and posted nothing, so the ticket said
 * only "on the Feature process, now at Spec" about work that had been stuck
 * for hours.
 *
 * Deliberately NOT a second notification system. There is no new table, no
 * new comment and no new delivery path — the case event was always the truth,
 * and this is a reader for it. That also means it disappears on its own the
 * moment the hold clears, which a posted comment never did.
 */
function IssueLifecycleHold({
  row,
  hold,
}: {
  row: IssueLinkedCase;
  hold: NonNullable<IssueLinkedCase["hold"]>;
}) {
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  const copy = describeStepHold(hold, { stepName: row.stage.name });
  if (!copy) return null;
  const itemHref = issueLifecycleCaseHref(row);

  async function handleRerun() {
    setRerunning(true);
    setRerunError(null);
    try {
      await pipelinesApi.rerunCurrentStageAutomation(row.id);
    } catch {
      setRerunError("Re-run request failed. Try again or open the case page.");
    } finally {
      setRerunning(false);
    }
  }

  return (
    <section
      data-testid="issue-lifecycle-hold"
      className="border-y border-amber-300 bg-amber-50/70 p-4 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-base font-semibold leading-tight" data-testid="issue-lifecycle-hold-headline">
              {copy.headline}
            </p>
            <p className="mt-1 text-sm opacity-80">
              The {row.pipeline.name} process has stopped and will not carry on by itself.
            </p>
          </div>

          {copy.detail ? (
            <p className="text-sm font-medium" data-testid="issue-lifecycle-hold-detail">
              {copy.detail}
            </p>
          ) : null}

          <p className="text-sm" data-testid="issue-lifecycle-hold-next-step">
            {copy.nextStep}
          </p>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              data-testid="issue-lifecycle-rerun-btn"
              size="sm"
              variant="outline"
              className="border-amber-400 bg-amber-100 hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/40 dark:hover:bg-amber-900/60"
              disabled={rerunning}
              onClick={handleRerun}
            >
              {rerunning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
              Re-run this step
            </Button>
            <Link to={itemHref} className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2">
              Open {row.stage.name}
              <ArrowUpRight className="h-3 w-3" aria-hidden />
            </Link>
          </div>

          {rerunError ? (
            <p className="text-sm text-red-700 dark:text-red-400">{rerunError}</p>
          ) : null}
        </div>
      </div>
    </section>
  );
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
  hold,
  onDecide,
  deciding,
  resolveUserLabel,
}: {
  row: IssueLinkedCase;
  review: NonNullable<IssueLinkedCase["review"]>;
  hold: NonNullable<IssueLinkedCase["hold"]> | null;
  onDecide?: (input: { row: IssueLinkedCase; decision: PipelineReviewDecision; reason: string | null }) => void;
  deciding: PipelineReviewDecision | null;
  resolveUserLabel?: (userId: string) => string | null;
}) {
  const [reason, setReason] = useState("");
  const [rerunning, setRerunning] = useState(false);
  const [rerunError, setRerunError] = useState<string | null>(null);

  async function handleRerun() {
    setRerunning(true);
    setRerunError(null);
    try {
      await pipelinesApi.rerunCurrentStageAutomation(row.id);
    } catch {
      setRerunError("Re-run request failed. Try again or open the case page.");
    } finally {
      setRerunning(false);
    }
  }
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

          {/*
            WHAT is being decided — the artifact, not a label.
            The ticket used to show `review.question` alone: the gate prompt
            its process was seeded with, written before this ticket existed.
            The brief carries the same question plus what the last step
            produced, what was already checked, and what has happened here
            before, so the decision is answerable without leaving the page.
            Same module the item page renders, so it cannot read two ways.
          */}
          <GateBrief approvalId={review.approvalId} fallbackQuestion={review.question} />


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

          {hold ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium" data-testid="issue-lifecycle-gate-hold-message">
                {hold.message ?? "This step has stopped and the gate cannot be decided until it is cleared."}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  data-testid="issue-lifecycle-gate-rerun-btn"
                  size="sm"
                  variant="outline"
                  className="border-amber-400 bg-amber-100 hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/40 dark:hover:bg-amber-900/60"
                  disabled={rerunning}
                  onClick={handleRerun}
                >
                  {rerunning ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
                  Re-run this step
                </Button>
              </div>
              {rerunError ? (
                <p className="text-sm text-red-700 dark:text-red-400">{rerunError}</p>
              ) : null}
            </div>
          ) : null}

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
