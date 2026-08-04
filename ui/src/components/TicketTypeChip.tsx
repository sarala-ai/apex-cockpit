/**
 * A ticket's type, rendered.
 *
 * The type is chosen once in the composer and, until now, never shown again —
 * so the one decision that determines which process a ticket runs was
 * invisible on every surface that displays the ticket.
 *
 * An undeclared type renders as UNDECLARED, not as nothing. A blank space
 * cannot be told apart from a surface that forgot to render the field, and the
 * whole point of showing this is to make the gap actionable.
 */
import { HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "../lib/utils";
import { ticketTypeMetaFor } from "../lib/ticket-type-meta";

/** The one place the undeclared state is worded. */
export const UNDECLARED_TICKET_TYPE_LABEL = "No type";
const UNDECLARED_TICKET_TYPE_TITLE =
  "No type declared, so this ticket runs no process. Set a type to put it on one.";

export function ticketTypeDisplayLabel(ticketType: string | null | undefined): string {
  return ticketType ? ticketTypeMetaFor(ticketType).label : UNDECLARED_TICKET_TYPE_LABEL;
}

export function TicketTypeChip({
  ticketType,
  className,
  showLabel = true,
}: {
  ticketType: string | null | undefined;
  className?: string;
  /** Icon-only form for dense rows; the label stays in the tooltip. */
  showLabel?: boolean;
}) {
  const meta = ticketType ? ticketTypeMetaFor(ticketType) : null;
  const Icon = meta?.icon ?? HelpCircle;
  const label = meta?.label ?? UNDECLARED_TICKET_TYPE_LABEL;
  return (
    <Badge
      variant="outline"
      data-testid="ticket-type-chip"
      data-ticket-type={ticketType ?? "undeclared"}
      title={meta ? label : UNDECLARED_TICKET_TYPE_TITLE}
      className={cn(
        "gap-1 font-normal [&>svg]:size-3",
        meta
          ? "text-muted-foreground"
          // Undeclared is a gap, not a value: dashed and dimmer, so it reads as
          // "nobody said" rather than as a type called "No type".
          : "border-dashed text-muted-foreground/70",
        className,
      )}
    >
      <Icon aria-hidden />
      {showLabel ? label : <span className="sr-only">{label}</span>}
    </Badge>
  );
}
