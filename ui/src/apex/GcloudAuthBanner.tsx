// gcloud / gh session-expiry banner (apex-tower migration — Task 2 §3).
//
// The detect→prompt seam for cloud credentials. It polls `/setup/auth` and, when
// a provider is unauthenticated OR its token has expired (`authed && !live`),
// shows an inline prompt. In LOCAL dev the "action" is guidance — run the CLI
// login (or re-run scripts/run-tower.sh, which installs apex + ensures auth at
// startup). A future hosted deployment keeps this exact component but swaps the
// guidance for an in-app OAuth redirect + per-user token store — the detection
// half (`live`) is deployment-agnostic and unchanged.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, RefreshCw } from "lucide-react";
import { apexSetupApi, type AuthStatus } from "../api/apex-setup";
import { Button } from "@/components/ui/button";

type ProviderState = "ok" | "expired" | "missing";

function stateOf(p: { authed: boolean; live: boolean }): ProviderState {
  if (!p.authed) return "missing";
  if (!p.live) return "expired";
  return "ok";
}

interface ProviderPrompt {
  label: string;
  state: Exclude<ProviderState, "ok">;
  fix: string; // the CLI a local operator runs to recover
}

function collectPrompts(auth: AuthStatus): ProviderPrompt[] {
  const prompts: ProviderPrompt[] = [];
  const g = stateOf(auth.google);
  if (g !== "ok") prompts.push({ label: "Google Cloud", state: g, fix: "gcloud auth login" });
  const h = stateOf(auth.github);
  if (h !== "ok") prompts.push({ label: "GitHub", state: h, fix: "gh auth login" });
  return prompts;
}

/**
 * Poll `/setup/auth` and prompt for re-auth on expiry. Renders nothing while all
 * credentials are live, so it's safe to mount high in the tree (page header, or
 * any cloud-dependent surface). `pollMs` defaults to 60s; it also refetches on
 * window focus so returning to the tab after a lapse surfaces the prompt promptly.
 */
export function GcloudAuthBanner({ pollMs = 60_000 }: { pollMs?: number }) {
  const queryClient = useQueryClient();
  const authQuery = useQuery({
    queryKey: ["apex-setup", "auth"],
    queryFn: () => apexSetupApi.auth(),
    refetchInterval: pollMs,
    refetchOnWindowFocus: true,
  });

  const auth = authQuery.data;
  if (!auth) return null;
  const prompts = collectPrompts(auth);
  if (prompts.length === 0) return null;

  const anyExpired = prompts.some((p) => p.state === "expired");

  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
        <KeyRound className="h-4 w-4 shrink-0" />
        {anyExpired ? "Cloud session expired" : "Cloud sign-in required"}
      </div>
      <div className="space-y-1.5 text-muted-foreground">
        {prompts.map((p) => (
          <div key={p.label} className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">{p.label}</span>
            <span>{p.state === "expired" ? "token expired —" : "not signed in —"} run</span>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{p.fix}</code>
          </div>
        ))}
        <p className="text-xs">
          Or re-run <code className="rounded bg-muted px-1 py-0.5">./scripts/run-tower.sh</code>,
          which refreshes auth and reinstalls the apex CLI at startup.
        </p>
      </div>
      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: ["apex-setup", "auth"] })
          }
          disabled={authQuery.isFetching}
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${authQuery.isFetching ? "animate-spin" : ""}`} />
          {authQuery.isFetching ? "Checking…" : "I've re-authenticated — re-check"}
        </Button>
      </div>
    </div>
  );
}
