import type { ApprovalBriefReviewPass } from "../api/approvals";

/**
 * The review passes a flow gate asks, shown BEFORE the decision.
 *
 * Why this exists: every defect this platform shipped in its first weeks was
 * caught by the founder reading the result, not by the system that produced
 * it (docs/architecture/review-passes.md). The questions were never hard —
 * they were unasked. So the gate asks them, at the moment of decision, in one
 * line each.
 *
 * Why nothing here blocks Approve: a required checkbox becomes a reflex click
 * within a week and teaches the reviewer to assert something they did not do.
 * A question that is read and silently answered has already done its work;
 * ticking is optional evidence, not a permission. The ticks that ARE made get
 * recorded with the decision, which is also how we will find out whether this
 * mechanism earns its place — a checklist nobody ever ticks over a month is a
 * checklist to delete, not to enforce.
 *
 * Read-only mode (no `onChange`) renders the same questions without
 * checkboxes — used where the decision is not submitted from this surface, so
 * a tick would be a control that does nothing.
 */
export function ReviewPassChecklist({
  passes,
  acknowledged,
  onChange,
}: {
  passes: ApprovalBriefReviewPass[];
  acknowledged?: string[];
  onChange?: (ids: string[]) => void;
}) {
  // No passes = no section at all. An empty "Before you decide" heading would
  // read as "checked, nothing found" — the opposite of the truth.
  if (passes.length === 0) return null;

  const ticked = new Set(acknowledged ?? []);
  const interactive = typeof onChange === "function";

  const toggle = (id: string) => {
    if (!onChange) return;
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(passes.map((p) => p.id).filter((pid) => next.has(pid)));
  };

  return (
    <div
      className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 px-3.5 py-3"
      data-testid="review-pass-checklist"
    >
      <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        Before you decide
      </p>
      <ul className="space-y-1.5">
        {passes.map((pass) =>
          interactive ? (
            <li key={pass.id}>
              <label className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="checkbox"
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-current"
                  checked={ticked.has(pass.id)}
                  onChange={() => toggle(pass.id)}
                  aria-label={`${pass.label}: ${pass.question}`}
                />
                <span className="leading-6">
                  <span className="text-foreground">{pass.question}</span>{" "}
                  <span className="text-(length:--text-micro) text-muted-foreground">{pass.label}</span>
                </span>
              </label>
            </li>
          ) : (
            <li key={pass.id} className="flex items-start gap-2.5">
              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="leading-6">
                <span className="text-foreground">{pass.question}</span>{" "}
                <span className="text-(length:--text-micro) text-muted-foreground">{pass.label}</span>
              </span>
            </li>
          ),
        )}
      </ul>
      {interactive && (
        <p className="text-(length:--text-micro) text-muted-foreground">
          Optional — ticking records what you checked; it never blocks the decision.
        </p>
      )}
    </div>
  );
}
