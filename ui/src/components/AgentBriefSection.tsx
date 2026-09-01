import { useState } from "react";
import { ChevronDown, Terminal } from "lucide-react";
import { InlineEditor } from "./InlineEditor";
import { cn } from "../lib/utils";

/**
 * The machine half of a ticket, kept out of the human reading surface.
 *
 * A ticket body should record the outcome wanted and the decision. The brief
 * an agent needs — object ids, coordinates, payload shapes, exact CLI
 * invocations — is a different artifact, and when it shared the description
 * field it made tickets unreadable (APE-5: sixty lines of Penpot change-op
 * where a sentence of intent belonged).
 *
 * So it lives in its own field and is hidden by default, with the same
 * disclosure idiom the thread uses for collapsed machine correspondence
 * (FlowMachineGroupRow): one plain label, aria-expanded, a rotating chevron.
 * Nothing is hidden from the agent — the brief reaches it in full through its
 * task context; this is a reading-surface concern only.
 *
 * When there is no brief, the section renders nothing at all: existing
 * tickets keep their body as their body and gain no empty chrome.
 */
export function AgentBriefSection({
  value,
  onSave,
}: {
  value: string | null | undefined;
  onSave: (agentBrief: string) => Promise<unknown> | void;
}) {
  const [expanded, setExpanded] = useState(false);
  const brief = value?.trim() ?? "";
  const detailsId = "agent-brief-details";

  if (!brief) return null;

  return (
    <div className="pt-1" data-testid="agent-brief-section">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded((current) => !current)}
        data-testid="agent-brief-toggle"
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <Terminal className="h-3 w-3 shrink-0" />
        <span>Agent brief</span>
        <span className="text-muted-foreground/70">
          {expanded ? "— hide" : "— machine detail for the agent, hidden by default"}
        </span>
        <ChevronDown
          className={cn("ml-auto h-3 w-3 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>
      <div id={detailsId} hidden={!expanded} className="pl-2">
        {expanded ? (
          <InlineEditor
            value={brief}
            onSave={(next) => onSave(next)}
            as="p"
            className="text-sm leading-6 text-muted-foreground"
            placeholder="Machine detail for the agent…"
            multiline
            foldable
          />
        ) : null}
      </div>
    </div>
  );
}
