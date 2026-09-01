/**
 * The list you land on when something has stopped.
 *
 * The sidebar count and the dashboard tile can only say HOW MANY. This says
 * which, and links to the ticket — because the ticket is where the block
 * already explains itself properly and where the re-run lives. Nothing is
 * re-explained here: one hold, one wording, and the wording lives in
 * `lib/step-hold`.
 *
 * Deliberately NOT dismissible. Every other row in the inbox has an X because
 * a person can reasonably judge it can wait. These cannot: the process is
 * refusing to advance, so the only thing that should clear the row is dealing
 * with the cause — which it does, on the next fetch, with nobody ticking
 * anything off.
 */
import { Link } from "react-router-dom";
import { OctagonAlert } from "lucide-react";
import type { PipelineStoppedStep } from "@paperclipai/shared";
import { STEP_HOLD_CONSEQUENCE, summariseStepHold, stoppedStepSectionLabel } from "../lib/step-hold";

export function StoppedWorkPanel({ steps }: { steps: PipelineStoppedStep[] }) {
  if (steps.length === 0) return null;

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {stoppedStepSectionLabel(steps.length)}
      </h3>
      <div className="divide-y divide-border border border-border">
        {steps.map((step) => {
          // A ticket if there is one, the process item otherwise. Never a dead
          // end: a stopped step that links nowhere is the same "you cannot get
          // to it from here" problem in a smaller box.
          const to = step.issue
            ? `/issues/${step.issue.id}`
            : `/pipelines/${step.pipelineId}/items/${step.caseId}`;
          return (
            <div
              key={step.caseId}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50"
            >
              <Link
                to={to}
                className="flex flex-1 cursor-pointer items-start gap-3 no-underline text-inherit"
              >
                <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
                <span className="min-w-0 text-sm">
                  <span className="font-medium">
                    {summariseStepHold({
                      stageName: step.stageName,
                      issueIdentifier: step.issue?.identifier ?? null,
                      issueTitle: step.issue?.title ?? null,
                    })}
                  </span>
                  {step.issue?.identifier && step.issue.title && (
                    <span className="text-muted-foreground"> — {step.issue.title}</span>
                  )}
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {step.hold.message?.trim() ? step.hold.message.trim() : STEP_HOLD_CONSEQUENCE}
                  </span>
                </span>
              </Link>
              {!step.isMine && (
                <span className="shrink-0 text-xs text-muted-foreground">Someone else's</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
