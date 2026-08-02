import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { ConfoundSet } from "@paperclipai/shared";
import { cn } from "../lib/utils";

/**
 * The confound statement, rendered wherever measurement evidence is shown.
 *
 * The doctrine is not "warn when convenient": an unclean verdict, LABELLED, is
 * worth more than a clean one that is wrong. So this component never hides —
 * when the window is clean it says so, which is itself information, and when it
 * is not it names the other initiatives that shipped alongside.
 *
 * `variant="inline"` is the compact form for list rows; the default is the
 * banner form for a detail surface.
 */
export function ConfoundWarning({
  confounds,
  variant = "banner",
  className,
}: {
  confounds: ConfoundSet;
  variant?: "banner" | "inline";
  className?: string;
}) {
  const unclean = !confounds.clean && Boolean(confounds.warning);

  if (variant === "inline") {
    if (!unclean) return null;
    return (
      <span
        className={cn("inline-flex items-center gap-1 text-xs text-amber-500", className)}
        title={confounds.warning ?? undefined}
        data-testid="confound-inline"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        {confounds.confoundingInitiatives.length === 1
          ? "1 other initiative in this window"
          : `${confounds.confoundingInitiatives.length} other initiatives in this window`}
      </span>
    );
  }

  if (!unclean) {
    return (
      <div
        className={cn(
          "flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2",
          className,
        )}
        data-testid="confound-clean"
      >
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <p className="text-sm text-emerald-500">
          No other initiative shipped in this measurement window — evidence from this window is
          attributable.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2",
        className,
      )}
      data-testid="confound-warning"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-amber-500">{confounds.warning}</p>
          <ul className="space-y-0.5">
            {confounds.confoundingInitiatives.map((initiative) => (
              <li
                key={initiative.initiativeId ?? "unattributed"}
                className="text-xs text-muted-foreground"
              >
                {initiative.initiativeTitle ?? "Unattributed changes"} ·{" "}
                {initiative.changeCount === 1 ? "1 change" : `${initiative.changeCount} changes`}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
