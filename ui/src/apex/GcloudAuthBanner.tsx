// gcloud / gh session-expiry banner (apex-tower migration — Task 2 §3).
//
// The detect→prompt seam for cloud credentials. It polls `/setup/auth` and, when
// a provider is unauthenticated OR its token has expired (`authed && !live`),
// shows an inline prompt. Truth has two sources (`auth.source`): "server" — the
// cockpit runs on the operator's own machine and probed itself; "workstation" —
// the operator's desktop app / `apex doctor --report` last reported. When
// `source` is "none" (hosted cockpit, this operator has never reported) the
// items are unknown, not failing, and the banner says so instead of prompting.
// Every remediation shown is an `apex` command or an in-app action — never a raw
// vendor CLI invocation.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudCog, KeyRound, RefreshCw } from "lucide-react";
import { apexSetupApi, type AuthStatus } from "../api/apex-setup";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";

type ProviderState = "ok" | "expired" | "missing";

/** The desktop bridge, when the cockpit renders inside the APEX desktop app. */
type ApexDesktopBridge = {
  cloudAuth?: { login: () => Promise<{ ok: boolean; error?: string }> };
  workstation?: { report: () => Promise<{ ok: boolean; reportedAt?: string; error?: string }> };
};

function stateOf(p: { authed: boolean; live: boolean }): ProviderState {
  if (!p.authed) return "missing";
  if (!p.live) return "expired";
  return "ok";
}

interface ProviderPrompt {
  label: string;
  state: Exclude<ProviderState, "ok">;
}

function collectPrompts(auth: AuthStatus): ProviderPrompt[] {
  const prompts: ProviderPrompt[] = [];
  const g = stateOf(auth.google);
  if (g !== "ok") prompts.push({ label: "Google Cloud", state: g });
  const h = stateOf(auth.github);
  if (h !== "ok") prompts.push({ label: "GitHub", state: h });
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

  const bridge = (window as unknown as { apexDesktop?: ApexDesktopBridge }).apexDesktop;
  const recheck = () => void queryClient.invalidateQueries({ queryKey: ["apex-setup", "auth"] });

  if (auth.source === "none") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <CloudCog className="h-4 w-4 shrink-0 text-muted-foreground" />
          Your workstation hasn't reported yet — open the APEX desktop app or run{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            apex doctor --report --cockpit-url {window.location.origin}
          </code>
          .
        </div>
        {bridge?.workstation ? (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void bridge.workstation!.report().then((r) => {
                  if (r.ok) recheck();
                })
              }
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Report now
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  if (auth.source === "stale") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
          <CloudCog className="h-4 w-4 shrink-0" />
          Your workstation's report is stale — reported{" "}
          {auth.reportedAt ? timeAgo(auth.reportedAt) : "a while ago"}; the cockpit no longer trusts it.
        </div>
        <div className="text-muted-foreground">
          Re-run{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
            apex doctor --report --cockpit-url {window.location.origin}
          </code>
        </div>
        {bridge?.workstation ? (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void bridge.workstation!.report().then((r) => {
                  if (r.ok) recheck();
                })
              }
            >
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              Report now
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

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
            <span>{p.state === "expired" ? "token expired." : "not signed in."}</span>
            {p.label === "Google Cloud" ? (
              bridge?.cloudAuth ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void bridge.cloudAuth!.login().then((r) => {
                      if (r.ok) recheck();
                    })
                  }
                >
                  Sign in to Google Cloud
                </Button>
              ) : (
                <span>Sign in from inside the APEX desktop app.</span>
              )
            ) : (
              <>
                <span>Run</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">apex connect github</code>
              </>
            )}
          </div>
        ))}
        {auth.source === "workstation" && auth.reportedAt ? (
          <p className="text-xs">reported by your workstation {timeAgo(auth.reportedAt)}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={recheck} disabled={authQuery.isFetching}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${authQuery.isFetching ? "animate-spin" : ""}`} />
          {authQuery.isFetching ? "Checking…" : "I've re-authenticated — re-check"}
        </Button>
        {auth.source === "workstation" ? (
          bridge?.workstation ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void bridge.workstation!.report().then((r) => {
                  if (r.ok) recheck();
                })
              }
            >
              Re-check
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">
              or run{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                apex doctor --report --cockpit-url {window.location.origin}
              </code>
            </span>
          )
        ) : null}
      </div>
    </div>
  );
}
