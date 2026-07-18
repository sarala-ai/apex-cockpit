// Guide-and-detect step body (apex-tower onboarding wizard).
//
// The HITL "guide + verify" surface for setup steps that aren't auto-run yet
// (OAuth client, gateway, MCP servers, per-tool governance). It shows the human
// instruction + an optional deep link (opens in a NEW TAB — never an iframe, since
// Google/GCP block framing) + an optional copy-paste command, then a "re-check"
// that re-polls the detector and lets the wizard auto-advance when the field flips.
// It never automates third-party consent — that stays human.

import { CheckCircle2, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface GuidedStepProps {
  description: string;
  /** Ordered human instructions. */
  instructions: React.ReactNode[];
  /** Optional external link — opened in a new tab. */
  deepLink?: { href: string; label: string };
  /** Optional copy-paste command (e.g. a gcloud / APEX-workflow invocation). */
  command?: string;
  done: boolean;
  onRecheck: () => void;
  rechecking: boolean;
}

export function GuidedStep({
  description,
  instructions,
  deepLink,
  command,
  done,
  onRecheck,
  rechecking,
}: GuidedStepProps) {
  return (
    <div className="space-y-3 text-sm" data-testid="wizard-guided-step">
      <p className="text-muted-foreground">{description}</p>

      {instructions.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          {instructions.map((node, i) => (
            <li key={i}>{node}</li>
          ))}
        </ol>
      )}

      {command && (
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-muted px-2 py-1 text-xs">{command}</code>
          <button
            type="button"
            title="Copy"
            onClick={() => void navigator.clipboard?.writeText(command)}
            className="text-muted-foreground transition hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        {deepLink && (
          <a href={deepLink.href} target="_blank" rel="noreferrer">
            <Button size="sm" variant="outline">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              {deepLink.label}
            </Button>
          </a>
        )}
        <Button size="sm" variant={done ? "outline" : "default"} onClick={onRecheck} disabled={rechecking}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${rechecking ? "animate-spin" : ""}`} />
          {rechecking ? "Checking…" : "Re-check"}
        </Button>
        {done && (
          <span className="flex items-center gap-1 text-xs text-emerald-500">
            <CheckCircle2 className="h-3.5 w-3.5" /> done
          </span>
        )}
      </div>
    </div>
  );
}
