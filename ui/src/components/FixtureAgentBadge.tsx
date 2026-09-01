import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { brandChipBadge } from "@/lib/status-colors";

/**
 * Provenance label ("Fixture") — this agent exists to validate the machinery,
 * not to do work. Like `BuiltInAgentBadge` it is a constant fact about the
 * agent, NOT a lifecycle state, so it never routes through
 * `StatusBadge`/`AgentStatusBadge`.
 *
 * Why it needs a visual mark at all: a fixture's *status* is usually a
 * perfectly healthy "idle", so nothing else on the row distinguishes it from
 * an agent that ships real work. The exclusion from pickers is enforced
 * server-side (packages/shared/src/agent-eligibility.ts); this badge is how a
 * reader looking at the full list knows why one row is missing from them.
 *
 * Undeclared agents (rosterKind === null) render NOTHING — no badge, no
 * "staff" claim. Nobody has said what they are, and inventing an answer on
 * screen is how an unchecked assumption becomes a fact people cite.
 */
export function FixtureAgentBadge({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        brandChipBadge.amber,
        compact && "px-1.5 py-0 text-(length:--text-nano)",
        className,
      )}
      title="Built to validate the platform, not to do work — cannot be assigned work or invoked"
      data-testid="fixture-agent-badge"
    >
      Fixture
    </Badge>
  );
}
