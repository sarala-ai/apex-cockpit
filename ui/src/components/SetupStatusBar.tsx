// Persistent IDE-style setup status bar (apex-tower onboarding).
//
// A thin, always-visible bottom bar — the ambient, auto-detected readout of every
// setup prerequisite (gcloud / GitHub / ADC / org / OAuth client / gateway / MCP),
// polling the same `GET /setup/state` detector the wizard renders. It replaces
// "navigate to /setup to check" with "glance at the bar; click the amber pip to
// fix." Quiet (muted) when everything's green; a visible amber/red pip when
// something needs attention. Each indicator routes to `/setup` (the wizard, which
// deep-dives the fix). On first load, if setup is incomplete, a dismissible
// startup prompt nudges into the wizard — closeable, and the bar remains the
// ambient reminder.
//
// Mounted globally (App shell), so it shows on every page. It renders nothing on
// unauthenticated / pre-company surfaces (auth, invite, claim, cli-auth, ux-lab)
// and whenever the detector isn't reachable (e.g. signed out) — failure-isolated,
// never blocking.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Rocket, X } from "lucide-react";
import { useLocation, useNavigate } from "@/lib/router";
import { setupStateApi, type SetupState } from "../api/apex-setup-state";
import { isSetupComplete, setupStepsProgress } from "../pages/setup/SetupWizard";

/** Surfaces where the bar must stay hidden (unauthenticated / pre-company). */
const HIDDEN_PATH_PREFIXES = ["/auth", "/cli-auth", "/invite", "/board-claim", "/ux-lab"];

/** Session key so the startup prompt nags at most once per session. */
const PROMPT_DISMISS_KEY = "apex.setupStartupPromptDismissed";

type Tone = "ok" | "warn" | "bad" | "muted";

interface Indicator {
  key: string;
  label: string;
  /** Optional terse value shown after the label (e.g. an MCP count). */
  value?: string;
  tone: Tone;
}

type Health = SetupState["auth"]["gcloud"];

function healthTone(h: Health): Tone {
  if (h === "ok") return "ok";
  if (h === "expired") return "warn";
  return "bad";
}

const DOT_CLASS: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
  muted: "bg-muted-foreground/40",
};

const TEXT_CLASS: Record<Tone, string> = {
  ok: "text-muted-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  bad: "text-red-600 dark:text-red-400",
  muted: "text-muted-foreground/60",
};

/** Flatten the detector snapshot into the bar's ordered indicators. */
function toIndicators(s: SetupState): Indicator[] {
  const mcpCount = s.mcpServers.registered.length;
  return [
    { key: "gcloud", label: "gcloud", tone: healthTone(s.auth.gcloud) },
    { key: "github", label: "GitHub", tone: healthTone(s.auth.gh) },
    { key: "adc", label: "ADC", tone: healthTone(s.auth.adc) },
    { key: "org", label: "Org", value: s.org.present ? "set" : "not set", tone: s.org.present ? "ok" : "warn" },
    { key: "oauth", label: "OAuth", tone: s.oauthClient.configured ? "ok" : "warn" },
    { key: "gateway", label: "Gateway", tone: s.gateway.reachable ? "ok" : "warn" },
    { key: "mcp", label: "MCP", value: String(mcpCount), tone: mcpCount > 0 ? "ok" : "muted" },
  ];
}

function StatusItem({ indicator, onClick }: { indicator: Indicator; onClick: () => void }) {
  const { label, value, tone } = indicator;
  return (
    <button
      type="button"
      data-testid={`setup-status-${indicator.key}`}
      data-tone={tone}
      onClick={onClick}
      title={`${label}: ${value ?? tone} — open setup`}
      className="flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 transition hover:bg-muted/60"
    >
      <span className={`inline-block size-2 rounded-full ${DOT_CLASS[tone]}`} aria-hidden />
      <span className={`text-xs ${TEXT_CLASS[tone]}`}>
        {label}
        {value ? <span className="ml-1 font-medium">{value}</span> : null}
      </span>
    </button>
  );
}

export function SetupStatusBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [promptDismissed, setPromptDismissed] = useState(
    () => sessionStorage.getItem(PROMPT_DISMISS_KEY) === "1",
  );

  const hidden = HIDDEN_PATH_PREFIXES.some((p) => location.pathname.startsWith(p));

  const { data, isError } = useQuery({
    queryKey: ["setup-state", "status-bar"],
    queryFn: () => setupStateApi.get(),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    retry: false,
    enabled: !hidden,
  });

  // Failure-isolated: hide on auth-ish routes, when the detector is unreachable
  // (e.g. signed out), or before the first snapshot arrives.
  if (hidden || isError || !data) return null;

  const indicators = toIndicators(data);
  const progress = setupStepsProgress(data);
  const complete = isSetupComplete(data);
  const goSetup = () => navigate("/setup");

  const showPrompt = !complete && !promptDismissed;

  return (
    <>
      {showPrompt ? (
        <div
          data-testid="setup-startup-prompt"
          className="fixed bottom-9 right-3 z-50 flex max-w-xs items-start gap-2.5 rounded-md border border-sky-300 bg-sky-50 px-3.5 py-2.5 shadow-lg dark:border-sky-500/25 dark:bg-sky-950/90"
        >
          <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-sky-900 dark:text-sky-100">Finish setting up Apex</p>
            <p className="mt-0.5 text-xs text-sky-800/80 dark:text-sky-200/70">
              {progress.total - progress.done} step{progress.total - progress.done === 1 ? "" : "s"} left —
              cloud auth, org scoping, and MCP capabilities.
            </p>
            <button
              type="button"
              data-testid="setup-startup-open"
              onClick={goSetup}
              className="mt-1.5 text-xs font-semibold text-sky-700 underline dark:text-sky-300"
            >
              Open setup →
            </button>
          </div>
          <button
            type="button"
            data-testid="setup-startup-dismiss"
            title="Dismiss"
            onClick={() => {
              sessionStorage.setItem(PROMPT_DISMISS_KEY, "1");
              setPromptDismissed(true);
            }}
            className="shrink-0 text-muted-foreground transition hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      <div
        data-testid="setup-status-bar"
        data-complete={complete ? "1" : "0"}
        className="fixed inset-x-0 bottom-0 z-40 flex h-7 items-center gap-1 overflow-x-auto border-t border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
      >
        <button
          type="button"
          data-testid="setup-status-summary"
          onClick={goSetup}
          title="Open setup"
          className={`flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium transition hover:bg-muted/60 ${
            complete ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
          }`}
        >
          <span className={`inline-block size-2 rounded-full ${complete ? DOT_CLASS.ok : DOT_CLASS.warn}`} aria-hidden />
          {complete ? "Setup ✓" : `Setup: ${progress.done}/${progress.total}`}
        </button>
        <span className="mx-0.5 h-3.5 w-px shrink-0 bg-border" aria-hidden />
        {indicators.map((ind) => (
          <StatusItem key={ind.key} indicator={ind} onClick={goSetup} />
        ))}
      </div>
    </>
  );
}
