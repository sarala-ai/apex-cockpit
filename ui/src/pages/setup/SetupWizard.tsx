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
import { STEP_HELP, HelpRail, StepInfo } from "./setup-help";
import { PRODUCT_NAME } from "../../lib/product";

// The cloud-first org→company engineering-setup spine. ORG steps (identity →
// create org → org cloud → org GitHub) provision the shared substrate; COMPANY
// steps (company cloud → company repos) provision each product unit; then the
// capability layer (OAuth client → gateway → MCP → connect → governance).
export type StepKey =
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
  // The step whose help the rail is showing. Null → follow the expanded/active
  // step; set by the ⓘ affordance to peek a step's help without expanding it.
  const [focusKey, setFocusKey] = useState<StepKey | null>(null);

  // Expanding a step (or nothing focused) drives the rail; ⓘ overrides it.
  const toggleStep = (key: StepKey) => {
    setFocusKey(null);
    setOpenKey((cur) => (cur === key ? null : key));
  };

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

  // The step whose guidance the help rail shows: an explicit ⓘ focus, else the
  // expanded step, else the active (first-incomplete) step.
  const railKey: StepKey | null = focusKey ?? openKey ?? activeKey;
  const railStep = STEPS.find((s) => s.key === railKey) ?? null;

  return (
    <div className="mx-auto max-w-5xl p-4" data-testid="apex-setup-wizard">
      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-4">
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
                    <div className="flex w-full items-center gap-2 px-3 py-2 text-sm">
                      <button
                        type="button"
                        onClick={() => toggleStep(step.key)}
                        aria-expanded={open}
                        className="flex flex-1 items-center gap-2 text-left"
                      >
                        {st.icon === "done" ? (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
                        ) : (
                          <Circle
                            className={`h-4 w-4 shrink-0 ${st.icon === "active" ? "text-sky-500" : "text-muted-foreground/40"}`}
                          />
                        )}
                        <span className="flex-1 font-medium">{step.title}</span>
                      </button>
                      <StatusBadge variant={st.variant}>{st.label}</StatusBadge>
                      <StepInfo
                        stepKey={step.key}
                        title={step.title}
                        help={STEP_HELP[step.key]}
                        onFocusRail={() => setFocusKey(step.key)}
                      />
                      <button
                        type="button"
                        onClick={() => toggleStep(step.key)}
                        aria-label={open ? "Collapse step" : "Expand step"}
                        className="text-muted-foreground transition hover:text-foreground"
                      >
                        {open ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </button>
                    </div>
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

        {/* Contextual help rail — wide screens only; narrow uses the ⓘ popover. */}
        <div className="hidden lg:sticky lg:top-4 lg:block">
          <HelpRail title={railStep?.title} help={railStep ? STEP_HELP[railStep.key] : undefined} />
        </div>
      </div>
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
      // Actions only — the "why" (this is your Google login, ADC needed, etc.)
      // lives in the help rail / ⓘ. The banner surfaces any expired/missing cred.
      return <GcloudAuthBanner />;
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
      // the two steps track the two completion criteria. (The "why" is in the rail.)
      return !orgPresent ? (
        <p className="text-sm text-muted-foreground">
          Create the Org first — then map this company’s repos (from the org’s repos).
        </p>
      ) : (
        <OrgScopingSection companyId={selectedCompanyId ?? undefined} slice="companyScope" />
      );
    case "oauthClient":
      return (
        <GuidedStep
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
          command="uvicorn mcpgateway.main:app --host 127.0.0.1 --port 4444"
          done={done}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      );
    case "mcpServers":
      return <GuidedStep done={done} onRecheck={onRecheck} rechecking={rechecking} />;
    case "connect":
      return <GuidedStep done={done} onRecheck={onRecheck} rechecking={rechecking} />;
    case "governance":
      return <GuidedStep done={done} onRecheck={onRecheck} rechecking={rechecking} />;
  }
}
