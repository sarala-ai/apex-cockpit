import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon: LucideIcon;
  /** Optional bold heading rendered above the message. */
  title?: string;
  message: string;
  action?: string;
  onAction?: () => void;
  /** Hide the leading "+" glyph on the action button (e.g. for a "Set up" CTA). */
  hideActionIcon?: boolean;
  /**
   * A second, quieter way out of the empty state.
   *
   * Some empty states are empty because nothing has happened yet, and "add one"
   * is the whole answer. Others are empty because the work happened somewhere
   * else first — a company with years of shipped product and no goals on the
   * board — and offering only "add one, by hand" is how such a board gets
   * abandoned instead of populated. That case needs a bulk route, and it is
   * secondary because it produces something to review rather than something
   * finished.
   */
  secondaryAction?: string;
  onSecondaryAction?: () => void;
  secondaryActionPending?: boolean;
  /** Rendered under the buttons. Use it to say what the secondary action will
   *  actually produce, so a bulk route is never mistaken for an import. */
  footnote?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  message,
  action,
  onAction,
  hideActionIcon = false,
  secondaryAction,
  onSecondaryAction,
  secondaryActionPending = false,
  footnote,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="bg-muted/50 p-4 mb-4">
        <Icon className="h-10 w-10 text-muted-foreground/50" />
      </div>
      {title && <p className="text-base font-semibold text-foreground mb-1.5">{title}</p>}
      <p className="text-sm text-muted-foreground mb-4 max-w-md">{message}</p>
      <div className="flex items-center justify-center gap-2">
        {action && onAction && (
          <Button onClick={onAction}>
            {!hideActionIcon && <Plus className="h-4 w-4 mr-1.5" />}
            {action}
          </Button>
        )}
        {secondaryAction && onSecondaryAction && (
          <Button variant="outline" onClick={onSecondaryAction} disabled={secondaryActionPending}>
            {secondaryActionPending ? "Starting…" : secondaryAction}
          </Button>
        )}
      </div>
      {footnote && (
        <p className="text-xs text-muted-foreground mt-3 max-w-md">{footnote}</p>
      )}
    </div>
  );
}
