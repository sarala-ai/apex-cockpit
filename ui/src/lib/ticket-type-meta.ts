/**
 * How a ticket type reads in the composer.
 *
 * The LABEL and the icon live here. The one thing that must never live here is
 * whether a type has a process — that is served per company by
 * `GET /companies/:id/ticket-types`, because a process is a seeded pipeline
 * row and a client-side answer would go stale the moment an operator archived
 * one or a company was seeded differently.
 *
 * The description a person reads is therefore BUILT from the server's answer
 * (`describeTicketTypeOption`), not stored. That is what keeps the chore option
 * honest: it does not say "no process" because someone typed that string next
 * to `chore`, it says it because the server reported `processlessByDesign` and
 * no pipeline.
 */

import {
  Bug,
  PenTool,
  Sparkles,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { TicketTypeOption } from "../api/issues";

export type TicketTypeMeta = {
  ticketType: string;
  label: string;
  icon: LucideIcon;
};

const TICKET_TYPE_META: Record<string, TicketTypeMeta> = {
  chore: { ticketType: "chore", label: "Chore", icon: Wrench },
  bug: { ticketType: "bug", label: "Bug", icon: Bug },
  "design-change": { ticketType: "design-change", label: "Design change", icon: PenTool },
  feature: { ticketType: "feature", label: "Feature", icon: Sparkles },
};

export function ticketTypeMetaFor(ticketType: string): TicketTypeMeta {
  return (
    TICKET_TYPE_META[ticketType] ?? {
      ticketType,
      label: ticketType,
      icon: Wrench,
    }
  );
}

/**
 * The one-line explanation shown under a type in the picker.
 *
 * Three genuinely different states, said differently on purpose:
 *
 *   - a live process        — name it, so the author knows what they started.
 *   - no process BY DESIGN  — say so plainly. A chore is a real ticket that
 *                             never enters a pipeline; hiding the option or
 *                             implying a process it does not have would both
 *                             be lies, in opposite directions.
 *   - no process, not by design — a gap on THIS board, not a decision. Worded
 *                             so nobody reads it as the chore case.
 */
export function describeTicketTypeOption(option: TicketTypeOption): string {
  if (option.pipelineId) {
    const name = option.pipelineName ?? option.ticketType;
    return option.commissionsRepoWritingAgent
      ? `Runs the ${name} process — commissions an agent that writes code.`
      : `Runs the ${name} process.`;
  }
  if (option.processlessByDesign) {
    return "No process, by design — tracked on the board like any ticket, but it never enters a pipeline.";
  }
  return "No process on this board yet — the pipeline for this type has not been seeded.";
}
