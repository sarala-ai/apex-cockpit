import type { Goal, GoalValidationCriterion } from "@paperclipai/shared";
import { isCriterionDue } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";

/** "2026-08-02T00:00:00.000Z" → "2 Aug 2026"; unparseable text passes through. */
function formatReviewDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function ownerLabel(criterion: GoalValidationCriterion): string | null {
  if (criterion.ownerUserId) return criterion.ownerUserId;
  if (criterion.ownerAgentId) return `agent ${criterion.ownerAgentId.slice(0, 8)}`;
  return null;
}

/**
 * The initiative-only part of a goal: the hypothesis (when there is a genuine
 * question), the budget, the stop condition, the assumption sheet, and — once
 * it ends — the closure with its reason.
 *
 * Everything here is conditional. A bare initiative (no hypothesis, no
 * assumptions) renders nothing rather than empty chrome, because a heading
 * over a blank row reads as "we wrote this down and it was empty" when the
 * truth is nobody wrote it down at all.
 */
export function InitiativeSummary({ goal }: { goal: Goal }) {
  if (goal.level !== "initiative") return null;

  const assumptions = goal.assumptions ?? [];
  const criteria = goal.validationCriteria ?? [];
  const hasAnything =
    Boolean(goal.hypothesis) ||
    Boolean(goal.budget) ||
    Boolean(goal.stopCondition) ||
    Boolean(goal.closure) ||
    Boolean(goal.provenance) ||
    assumptions.length > 0 ||
    criteria.length > 0;

  if (!hasAnything) return null;

  return (
    <section className="space-y-4" aria-label="Initiative">
      {goal.hypothesis && (
        <div className="space-y-1">
          <h3 className="text-xs uppercase text-muted-foreground">Hypothesis</h3>
          <p className="text-sm">{goal.hypothesis}</p>
        </div>
      )}

      {(goal.budget || goal.stopCondition) && (
        <div className="space-y-1">
          {goal.budget && (
            <div className="flex items-start gap-3">
              <span className="text-xs text-muted-foreground shrink-0 w-28 mt-0.5">
                Budget
              </span>
              <span className="text-sm min-w-0">{goal.budget}</span>
            </div>
          )}
          {goal.stopCondition && (
            <div className="flex items-start gap-3">
              <span className="text-xs text-muted-foreground shrink-0 w-28 mt-0.5">
                Stop condition
              </span>
              <span className="text-sm min-w-0">{goal.stopCondition}</span>
            </div>
          )}
        </div>
      )}

      {goal.provenance && (
        <div className="flex items-start gap-3">
          <span className="text-xs text-muted-foreground shrink-0 w-28 mt-0.5">Provenance</span>
          <span className="text-sm min-w-0">
            <StatusBadge status={goal.provenance.kind} />
            {goal.provenance.source && (
              <span className="ml-2 text-muted-foreground">{goal.provenance.source}</span>
            )}
          </span>
        </div>
      )}

      {criteria.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs uppercase text-muted-foreground">
            Validation criteria ({criteria.length})
          </h3>
          <ul className="border border-border">
            {criteria.map((criterion) => {
              // Due today or overdue and still unreported. This has to be
              // impossible to miss: an unread criterion is the failure the
              // whole object exists to prevent, and a quiet grey row is how it
              // goes unread again.
              const overdue = isCriterionDue(criterion);
              const reviewDate = formatReviewDate(criterion.reviewDate);
              const owner = ownerLabel(criterion);
              return (
                <li
                  key={criterion.id}
                  className={
                    "flex items-start gap-2 px-3 py-1.5 text-sm border-b border-border last:border-b-0" +
                    (overdue ? " bg-destructive/10" : "")
                  }
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p>{criterion.statement}</p>
                    <p className="text-xs text-muted-foreground">
                      {criterion.threshold && <span>{criterion.threshold}</span>}
                      {criterion.threshold && criterion.measure && <span> · </span>}
                      {criterion.measure && <span>{criterion.measure}</span>}
                      {criterion.window && <span> · {criterion.window}</span>}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {owner ?? "no reader"}
                      {reviewDate && <span> · reviews {reviewDate}</span>}
                      {overdue && (
                        <span className="ml-2 font-medium text-destructive">Due for review</span>
                      )}
                    </p>
                    {criterion.reviewNote && (
                      <p className="text-xs text-muted-foreground">{criterion.reviewNote}</p>
                    )}
                  </div>
                  <StatusBadge status={criterion.status} />
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {goal.closure && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <h3 className="text-xs uppercase text-muted-foreground">Closed as</h3>
            <StatusBadge status={goal.closure} />
          </div>
          {goal.closureReason && (
            <p className="text-sm text-muted-foreground">{goal.closureReason}</p>
          )}
        </div>
      )}

      {assumptions.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs uppercase text-muted-foreground">
            Assumptions ({assumptions.length})
          </h3>
          <ul className="border border-border">
            {assumptions.map((assumption) => (
              <li
                key={assumption.id}
                className="flex items-start gap-2 px-3 py-1.5 text-sm border-b border-border last:border-b-0"
              >
                <span className="text-xs text-muted-foreground shrink-0 w-24 mt-0.5 capitalize">
                  {assumption.type}
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p>{assumption.statement}</p>
                  {assumption.evidence && (
                    <p className="text-xs text-muted-foreground">{assumption.evidence}</p>
                  )}
                </div>
                <StatusBadge status={assumption.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
