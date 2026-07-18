// Dismissible "finish setup" nudge (apex-tower onboarding wizard entry point).
//
// Renders on the dashboard when `/setup/state` shows setup is incomplete, linking
// to the wizard. Non-blocking + dismissible — it never gates the app.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Rocket, X } from "lucide-react";
import { useActiveCompanyPrefix } from "@/lib/router";
import { setupStateApi } from "../../api/apex-setup-state";
import { isSetupComplete } from "./SetupWizard";

const DISMISS_KEY = "apex.setupNudgeDismissed";

export function SetupNudge() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1");
  const prefix = useActiveCompanyPrefix();
  const { data } = useQuery({
    queryKey: ["setup-state"],
    queryFn: () => setupStateApi.get(),
    staleTime: 30_000,
  });

  if (dismissed || !prefix || !data || isSetupComplete(data)) return null;

  return (
    <div
      data-testid="setup-nudge"
      className="flex items-center justify-between gap-3 rounded-md border border-sky-300 bg-sky-50 px-4 py-3 dark:border-sky-500/25 dark:bg-sky-950/40"
    >
      <div className="flex items-center gap-2.5">
        <Rocket className="h-4 w-4 shrink-0 text-sky-600 dark:text-sky-400" />
        <p className="text-sm text-sky-900 dark:text-sky-100">
          Finish setting up apex-tower — cloud auth, org scoping, and MCP capabilities.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <a href={`/${prefix}/setup`} className="text-sm font-medium text-sky-700 underline dark:text-sky-300">
          Open setup
        </a>
        <button
          type="button"
          title="Dismiss"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, "1");
            setDismissed(true);
          }}
          className="text-muted-foreground transition hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
