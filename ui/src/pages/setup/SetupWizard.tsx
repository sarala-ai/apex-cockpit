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
import { PRODUCT_NAME } from "../../lib/product";

// The cloud-first org→company engineering-setup spine. ORG steps (identity →
// create org → org cloud → org GitHub) provision the shared substrate; COMPANY
// steps (company cloud → company repos) provision each product unit; then the
// capability layer (OAuth client → gateway → MCP → connect → governance).
type StepKey =
  | "auth"
  | "org"
  | "orgCloud"
  | "orgGithub"
  | "companyCloud"
  | "companyRepos"
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
  {
    key: "auth",
    title: "Connect gcloud + GitHub (your identity)",
    done: (s) => s.auth.gcloud === "ok" && s.auth.gh === "ok" && s.auth.adc === "ok",
  },
  { key: "org", title: "Create Org (you = owner)", done: (s) => s.org.present },
  {
    key: "orgCloud",
    title: "Org cloud — shared GCP projects",
    done: (s) => s.scoping.orgProjectsBound,
  },
  {
    key: "orgGithub",
    title: "Org GitHub — App + Workload Identity Federation",
    done: (s) => s.orgGithub.appInstalled && s.orgGithub.wifConfigured,
  },
  {
    key: "companyCloud",
    title: "Company cloud — GCP projects",
    done: (s) => s.companies.count > 0 && s.scoping.companyProjectsBound,
  },
  {
    key: "companyRepos",
    title: "Company repos",
    done: (s) => s.companies.count > 0 && s.scoping.companyReposBound,
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

/**
 * The cloud/repo-heavy steps. They're required for owner/admin/contributor roles
 * (who provision + execute) but SKIPPED for reviewer/observer — the future
 * no-cloud read-only tiers who review/approve/observe under the org identity and
 * never need their own cloud access. (Don't hardcode "everyone needs cloud.")
 * `auth` + `org` stay required for all roles (identity + org membership).
 */
const CLOUD_STEP_KEYS = new Set<StepKey>([
  "orgCloud",
  "orgGithub",
  "companyCloud",
  "companyRepos",
  "oauthClient",
  "gateway",
  "mcpServers",
  "connect",
]);

/** Roles that DON'T provision/execute → cloud steps don't apply.
 *  reviewer/observer are placeholders for the read-only tiers (not yet mintable). */
function roleNeedsCloud(role?: string): boolean {
  return role !== "reviewer" && role !== "observer";
}

/** Steps that count toward "required" given the actor's role. */
function requiredSteps(s: SetupState): StepDef[] {
  const needsCloud = roleNeedsCloud(s.membership?.role);
  return STEPS.filter((st) => !st.optional && (needsCloud || !CLOUD_STEP_KEYS.has(st.key)));
}

/** True when every required (role-aware) prerequisite is satisfied. */
export function isSetupComplete(s: SetupState): boolean {
  return requiredSteps(s).every((st) => st.done(s));
}

/** Role-aware progress: how many required steps are done out of the total, and
 *  whether setup is complete. Drives the status bar's "N left / ✓ complete"
 *  summary without duplicating the role-gating logic. */
export function setupStepsProgress(s: SetupState): { done: number; total: number; complete: boolean } {
  const required = requiredSteps(s);
  const done = required.filter((st) => st.done(s)).length;
  return { done, total: required.length, complete: done === required.length };
}

function statusOf(
  step: StepDef,
  state: SetupState,
  activeKey: StepKey | null,
  isRequired: boolean,
): { label: string; variant: StatusVariant; icon: "done" | "active" | "pending" } {
  if (step.done(state)) return { label: "done", variant: "success", icon: "done" };
  if (step.optional) return { label: "optional", variant: "default", icon: "pending" };
  // Non-optional but not required for THIS role (reviewer/observer skip cloud).
  if (!isRequired) return { label: "skipped", variant: "default", icon: "pending" };
  if (step.key === activeKey) return { label: "current", variant: "info", icon: "active" };
  return { label: "pending", variant: "default", icon: "pending" };
}

/** One-line banner copy for the org/membership state branch. */
function membershipBranch(state: SetupState): {
  testid: string;
  tone: "info" | "warn" | "success";
  title: string;
  body: string;
} {
  if (!state.org.present) {
    return {
      testid: "branch-bootstrap-owner",
      tone: "info",
      title: "You're setting up a new instance — you'll be the org owner.",
      body: "No org exists yet. Connect your identity, then create the org; you're recorded as its owner (active). Later users are mapped as members an owner approves.",
    };
  }
  const m = state.membership;
  if (m?.present && m.status === "active") {
    return {
      testid: "branch-member-active",
      tone: "success",
      title: `You're an active ${m.role ?? "member"} of this org.`,
      body: "Continue with the setup steps below for your role.",
    };
  }
  if (m?.present && m.status === "pending") {
    return {
      testid: "branch-awaiting-approval",
      tone: "warn",
      title: "Request sent — awaiting an org admin's approval.",
      body: "Your membership is pending. An owner/admin must approve you before org-scoped setup unlocks. (Approval UI is a placeholder — approve via the org members API for now.)",
    };
  }
  return {
    testid: "branch-request-access",
    tone: "warn",
    title: "This org already exists — request access to join.",
    body: "You're not a member yet. Connect your identity, then request access; an owner/admin approves you.",
  };
}

export function SetupWizard() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();

  // Same query key as SetupStatusBar's — one shared cache entry so invalidating
  // either surface (e.g. after creating the org, or the status bar's poll)
  // refreshes both; react-query dedupes the underlying fetches.
  const stateQuery = useQuery({
    queryKey: ["setup-state"],
    queryFn: () => setupStateApi.get(),
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    retry: 2,
  });

  const recheck = () => void queryClient.invalidateQueries({ queryKey: ["setup-state"] });
  const [openKey, setOpenKey] = useState<StepKey | null>(null);

  const state = stateQuery.data;
  const required = state ? requiredSteps(state) : STEPS.filter((s) => !s.optional);
  const requiredKeys = new Set(required.map((s) => s.key));
  const doneCount = state ? required.filter((s) => s.done(state)).length : 0;
  const activeKey: StepKey | null = state
    ? (required.find((s) => !s.done(state))?.key ?? null)
    : null;
  const complete = state != null && activeKey == null;
  // Identity is the hard gate: nothing org/cloud-scoped proceeds until gcloud+gh
  // are both green.
  const authReady = state != null && state.auth.gcloud === "ok" && state.auth.gh === "ok";

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
            <span>Set up {PRODUCT_NAME}</span>
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

          {(() => {
            const branch = membershipBranch(state);
            const toneClass =
              branch.tone === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                : branch.tone === "warn"
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-600"
                  : "border-sky-500/30 bg-sky-500/10 text-sky-600";
            return (
              <div
                className={`mb-4 rounded-md border px-4 py-3 text-sm ${toneClass}`}
                data-testid="wizard-branch"
                data-branch={branch.testid}
              >
                <div className="font-medium">{branch.title}</div>
                <div className="mt-0.5 text-xs opacity-90">{branch.body}</div>
              </div>
            );
          })()}

          <ul className="space-y-2">
            {STEPS.map((step) => {
              const isRequired = requiredKeys.has(step.key);
              const st = statusOf(step, state, activeKey, isRequired);
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
                        orgPresent={state.org.present}
                        done={step.done(state)}
                        authReady={authReady}
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
  orgPresent,
  done,
  authReady,
  onRecheck,
  rechecking,
}: {
  stepKey: StepKey;
  selectedCompanyId: string | null;
  orgPresent: boolean;
  done: boolean;
  authReady: boolean;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  // Identity is the hard gate — every org/cloud-scoped step is blocked until
  // gcloud + gh are both green. The identity step itself is never gated.
  if (stepKey !== "auth" && !authReady) {
    return (
      <div
        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-600"
        data-testid="wizard-auth-gate"
      >
        Connect your identity first — finish “Connect gcloud + GitHub” (both must be green) to unlock this step.
      </div>
    );
  }
  switch (stepKey) {
    case "auth":
      return (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            <b>This is your login.</b> <code>gcloud auth login</code> signs you in with your
            Google account — it <b>is</b> the Google/Gmail login (same account); there’s no
            separate sign-in page. <code>gh auth login</code> connects your GitHub identity. Apex is
            tied to gcloud + GitHub, so this is step one.
          </p>
          <p>
            Discovery + the AR pull read your local <code>gcloud</code> / <code>gh</code> auth. Fix
            any expired/missing credential below; ADC —{" "}
            <code>gcloud auth application-default login</code> — is also needed for the apex install.
          </p>
          <GcloudAuthBanner />
        </div>
      );
    case "org":
      // Create the holding Org (you become its owner). Company link/summary too.
      return <OrgScopingSection companyId={selectedCompanyId ?? undefined} slice="org" />;
    case "orgCloud":
      // Bind the org's SHARED GCP projects (CI/CD + Artifact Registry, shared
      // Secret Manager, observability) at org scope.
      return !orgPresent ? (
        <p className="text-sm text-muted-foreground">
          Create the Org first (step above) — then bind its shared GCP projects here.
        </p>
      ) : (
        <OrgScopingSection companyId={selectedCompanyId ?? undefined} slice="orgScope" />
      );
    case "orgGithub":
      return (
        <GuidedStep
          description="Connect the GitHub ORG to GCP once, keylessly: install the Apex GitHub App on the org, then create the single org-level Workload Identity Federation pool + provider that trusts your whole GitHub org. Per-repo authorization comes later, in the company steps."
          instructions={[
            <span key="app">
              <b>Install the GitHub App</b> on the org (fine-grained, per-install token — not a
              personal PAT). Permissions: <code>contents:rw</code>, <code>pull_requests</code>,{" "}
              <code>actions</code>, <code>checks</code>, <code>workflows</code>,{" "}
              <code>environments</code>, <code>metadata</code>. Select the repos it may touch.
            </span>,
            <div key="wif">
              <b>One org-level WIF pool + provider</b> (create once, host in the shared project,
              e.g. <code>sarala-cicd</code>). Scope trust to the whole org via the provider’s
              attribute condition:
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                <li key="cond">
                  <code>assertion.repository_owner == 'sarala-ai'</code> — trust every repo in the
                  org. <b>Do not</b> create a pool/provider per repo.
                </li>
                <li key="claims">
                  WIF can filter only on <code>repository</code>, <code>repository_owner</code>,{" "}
                  and <code>environment</code> (GitHub OIDC claims). GitHub is flat (no subgroups);
                  “company = group of repos” is an Apex-side grouping — a GitHub Team / custom
                  property is optional and <b>not</b> in the OIDC claims.
                </li>
              </ul>
            </div>,
            <span key="auth">
              <b>Authorization stays per-repo (+ per-environment)</b> and is set up in the Company
              steps: IAM-bind{" "}
              <code>principalSet://…/attribute.repository/&lt;org&gt;/&lt;repo&gt;</code> (optionally
              plus <code>attribute.environment</code>) → that env’s least-privilege deploy SA. The
              SAs can live in <b>any</b> project (each company’s own) — only the pool/provider is
              pinned to the shared host project. This fuses WIF + GitHub Environments +
              required-reviewers into one keyless, approval-gated deploy path.
            </span>,
          ]}
          deepLink={{
            href: "https://github.com/organizations/sarala-ai/settings/installations",
            label: "Open GitHub org apps →",
          }}
          done={done}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      );
    case "companyCloud":
      // Bind THIS company's own GCP projects (dev/staging/prod) at company scope.
      return !orgPresent ? (
        <p className="text-sm text-muted-foreground">
          Create the Org first — company scoping cascades under it.
        </p>
      ) : (
        <OrgScopingSection companyId={selectedCompanyId ?? undefined} slice="companyScope" />
      );
    case "companyRepos":
      // Bind this company's repos (subset of the org's). Same company-scope
      // editor as company-cloud — one binding row holds both GCP projects + repos;
      // the two steps track the two completion criteria.
      return !orgPresent ? (
        <p className="text-sm text-muted-foreground">
          Create the Org first — then map this company’s repos (from the org’s repos).
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Pick the repos this company owns from the org’s repos — the per-repo(+env) deploy-SA
            WIF bindings (see the Org GitHub step) are generated from this company↔repo grouping.
          </p>
          <OrgScopingSection companyId={selectedCompanyId ?? undefined} slice="companyScope" />
        </div>
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
