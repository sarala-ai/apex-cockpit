// apex-tower onboarding wizard — the shell (docs/APEX_TOWER_ONBOARDING_WIZARD.md).
//
// A resumable, state-aware setup screen. It is a pure function of the detector
// (`GET /setup/state`): it renders the ordered steps as a checklist, derives each
// step's status from live state, and expands the first incomplete step. Auto steps
// embed their real component (auth banner, Org/scoping); not-yet-built steps use the
// HITL "guide + detect" placeholder. Re-entering resumes wherever state stands; when
// every required prerequisite passes it shows "setup complete".

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, Circle, PartyPopper } from "lucide-react";
import { setupStateApi, type SetupState } from "../../api/apex-setup-state";
import { useCompany } from "../../context/CompanyContext";
import { GcloudAuthBanner } from "@/apex/GcloudAuthBanner";
import { OrgScopingSection } from "../company-settings/OrgScopingSection";
import { StatusBadge, type StatusVariant } from "@/apex/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GuidedStep } from "./GuidedStep";

type StepKey =
  | "auth"
  | "org"
  | "scoping"
  | "oauthClient"
  | "gateway"
  | "mcpServers"
  | "connect"
  | "governance";

interface StepDef {
  key: StepKey;
  title: string;
  optional?: boolean;
  done: (s: SetupState) => boolean;
}

const STEPS: StepDef[] = [
  { key: "auth", title: "Local cloud auth (gcloud / gh)", done: (s) => s.auth.gcloud === "ok" && s.auth.gh === "ok" },
  { key: "org", title: 'Org "Sarala"', done: (s) => s.org.present },
  {
    key: "scoping",
    title: "Companies + GCP / repo scoping",
    done: (s) => s.companies.count > 0 && (s.scoping.orgBound || s.scoping.companyBound),
  },
  { key: "oauthClient", title: "Google OAuth client", done: (s) => s.oauthClient.configured },
  { key: "gateway", title: "MCP gateway running", done: (s) => s.gateway.reachable },
  { key: "mcpServers", title: "MCP servers registered", done: (s) => s.mcpServers.registered.length > 0 },
  {
    key: "connect",
    title: "Connect capability (your Google consent)",
    done: (s) => s.oauthClient.configured && s.mcpServers.registered.length > 0,
  },
  { key: "governance", title: "Per-tool governance", optional: true, done: () => false },
];

/** True when every required (non-optional) prerequisite is satisfied. */
export function isSetupComplete(s: SetupState): boolean {
  return STEPS.filter((st) => !st.optional).every((st) => st.done(s));
}

function statusOf(
  step: StepDef,
  state: SetupState,
  activeKey: StepKey | null,
): { label: string; variant: StatusVariant; icon: "done" | "active" | "pending" } {
  if (step.done(state)) return { label: "done", variant: "success", icon: "done" };
  if (step.optional) return { label: "optional", variant: "default", icon: "pending" };
  if (step.key === activeKey) return { label: "current", variant: "info", icon: "active" };
  return { label: "pending", variant: "default", icon: "pending" };
}

export function SetupWizard() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();

  const stateQuery = useQuery({
    queryKey: ["setup-state"],
    queryFn: () => setupStateApi.get(),
    refetchOnWindowFocus: true,
  });

  const recheck = () => void queryClient.invalidateQueries({ queryKey: ["setup-state"] });
  const [openKey, setOpenKey] = useState<StepKey | null>(null);

  const state = stateQuery.data;
  const required = STEPS.filter((s) => !s.optional);
  const doneCount = state ? required.filter((s) => s.done(state)).length : 0;
  const activeKey: StepKey | null = state
    ? (required.find((s) => !s.done(state))?.key ?? null)
    : null;
  const complete = state != null && activeKey == null;

  // Default the expanded step to the active one whenever state resolves/changes.
  useEffect(() => {
    if (activeKey) setOpenKey(activeKey);
  }, [activeKey]);

  if (stateQuery.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Detecting setup state…</div>;
  }
  if (!state) {
    return (
      <div className="p-6 text-sm text-destructive">
        Could not read setup state
        {stateQuery.error instanceof Error ? `: ${stateQuery.error.message}` : ""}.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4" data-testid="apex-setup-wizard">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Set up apex-tower</span>
            {complete ? (
              <StatusBadge variant="success">complete</StatusBadge>
            ) : (
              <StatusBadge variant="info">
                {doneCount}/{required.length} done
              </StatusBadge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {complete && (
            <div
              className="mb-4 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-500"
              data-testid="wizard-complete"
            >
              <PartyPopper className="h-4 w-4" /> Setup complete — every prerequisite is satisfied.
            </div>
          )}

          <ul className="space-y-2">
            {STEPS.map((step) => {
              const st = statusOf(step, state, activeKey);
              const open = openKey === step.key;
              return (
                <li
                  key={step.key}
                  className="rounded-md border border-border"
                  data-testid={`wizard-step-${step.key}`}
                  data-status={st.label}
                >
                  <button
                    type="button"
                    onClick={() => setOpenKey(open ? null : step.key)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                  >
                    {st.icon === "done" ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                    ) : (
                      <Circle
                        className={`h-4 w-4 shrink-0 ${st.icon === "active" ? "text-sky-500" : "text-muted-foreground/40"}`}
                      />
                    )}
                    <span className="flex-1 font-medium">{step.title}</span>
                    <StatusBadge variant={st.variant}>{st.label}</StatusBadge>
                    {open ? (
                      <ChevronDown className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    )}
                  </button>
                  {open && (
                    <div className="border-t border-border px-3 py-3">
                      <StepBody
                        stepKey={step.key}
                        selectedCompanyId={selectedCompanyId}
                        done={step.done(state)}
                        onRecheck={recheck}
                        rechecking={stateQuery.isFetching}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function StepBody({
  stepKey,
  selectedCompanyId,
  done,
  onRecheck,
  rechecking,
}: {
  stepKey: StepKey;
  selectedCompanyId: string | null;
  done: boolean;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  switch (stepKey) {
    case "auth":
      return (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Discovery + the AR pull read your local <code>gcloud</code> / <code>gh</code> auth. Fix
            any expired/missing credential below; ADC (application-default) is needed for the apex
            install.
          </p>
          <GcloudAuthBanner />
        </div>
      );
    case "org":
    case "scoping":
      return selectedCompanyId ? (
        <OrgScopingSection companyId={selectedCompanyId} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Select or create a company first (under <a className="underline" href="/companies">Companies</a>),
          then the Org + scoping editor appears here.
        </p>
      );
    case "oauthClient":
      return (
        <GuidedStep
          description="One Google OAuth client (Web app) backs both SSO and per-user Workspace access. Enabling APIs + creating the client are scriptable (the APEX workflow does them); the consent screen has a console step, and you consent to your own account later — no service account, no delegation."
          instructions={[
            <span key="apis">
              <b>Enable APIs</b> in the project: <code>gmail</code>, <code>docs</code>,{" "}
              <code>sheets</code>, <code>drive</code>.googleapis.com
            </span>,
            <div key="scopes">
              <b>OAuth consent screen → Internal</b> (sarala.ai). Required scopes:
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                <li key="id">
                  <code>openid</code> · <code>userinfo.email</code> · <code>userinfo.profile</code> — identity / SSO
                </li>
                <li key="gmail">
                  <code>gmail.modify</code> — Gmail read / send / modify
                </li>
                <li key="docs">
                  <code>documents</code> — Google Docs
                </li>
                <li key="sheets">
                  <code>spreadsheets</code> — Google Sheets
                </li>
                <li key="drive">
                  <code>drive.file</code> — Drive (per-file)
                </li>
              </ul>
            </div>,
            <span key="client">
              Create one <b>OAuth 2.0 Client (Web application)</b>. Authorized redirect URIs:{" "}
              <code>http://localhost:8001/oauth2callback</code> (dev) + your planned cloud URL.
            </span>,
            <span key="secret">
              Copy the <b>client id + secret</b> → store the secret in Secret Manager (the APEX
              workflow does this). Requires the <code>iam.oauthClientAdmin</code> role for the API path.
            </span>,
          ]}
          deepLink={{
            href: "https://console.cloud.google.com/apis/credentials",
            label: "Open GCP Credentials →",
          }}
          command="apex run workflow run --workflow gateway-oauth-bootstrap --execution-mode apply"
          done={done}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      );
    case "gateway":
      return (
        <GuidedStep
          description="Start the apex-gateway (ContextForge MCP gateway); the wizard detects it via /health."
          instructions={["Run the gateway locally, or point APEX_GATEWAY_URL at a running instance."]}
          command="uvicorn mcpgateway.main:app --host 127.0.0.1 --port 4444"
          done={done}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      );
    case "mcpServers":
      return (
        <GuidedStep
          description="Register the MCP servers whose tools your agents should see (e.g. the Google Workspace MCP). The gateway federates their tools into one catalog."
          instructions={[
            "Register an upstream MCP server: POST /gateways with its endpoint + transport.",
            "The gateway auto-connects, lists its tools, and federates them.",
          ]}
          done={done}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      );
    case "connect":
      return (
        <GuidedStep
          description="Authorize your own Google account once (per-user OAuth via the gateway broker). No service account, no delegation — you authorize you."
          instructions={[
            "Start the per-user OAuth flow for the Workspace gateway and approve consent in the browser.",
            "The broker stores your token; the wizard detects the connection.",
          ]}
          done={done}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      );
    case "governance":
      return (
        <GuidedStep
          description="Optional: allowlist which of the federated tools each company / agent may use — the resolver cascade applied to the catalog. Configured once tools are federated."
          instructions={["Scope the federated tool catalog per org / company / agent."]}
          done={done}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      );
  }
}
