// apex-tower onboarding wizard — the shell (docs/APEX_TOWER_ONBOARDING_WIZARD.md).
//
// A resumable, state-aware setup screen. It is a pure function of the detector
// (`GET /setup/state`): it renders the ordered steps as a checklist, derives each
// step's status from live state, and expands the first incomplete step. Auto steps
// embed their real component (auth banner, Org/scoping); not-yet-built steps use the
// HITL "guide + detect" placeholder. Re-entering resumes wherever state stands; when
// every required prerequisite passes it shows "setup complete".

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, Circle, PartyPopper } from "lucide-react";
import { setupStateApi, type SetupState } from "../../api/apex-setup-state";
import { setupModelsApi } from "../../api/apex-setup-models";
import { orgsApi } from "../../api/apex-scoping";
import { useCompany } from "../../context/CompanyContext";
import { GcloudAuthBanner } from "@/apex/GcloudAuthBanner";
import { OrgScopingSection } from "../company-settings/OrgScopingSection";
import { StatusBadge, type StatusVariant } from "@/apex/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GuidedStep } from "./GuidedStep";
import { STEP_HELP, HelpRail, StepInfo } from "./setup-help";
import { PRODUCT_NAME } from "../../lib/product";

// The cloud-first org→company engineering-setup spine. ORG steps (identity →
// create org → org cloud → org GitHub) provision the shared substrate; COMPANY
// steps (company cloud → company repos) provision each product unit; then the
// capability layer (OAuth client → gateway → MCP → connect → models → governance).
export type StepKey =
  | "auth"
  | "org"
  | "companies"
  | "orgCloud"
  | "orgGithub"
  | "companyCloud"
  | "companyRepos"
  | "oauthClient"
  | "gateway"
  | "mcpServers"
  | "connect"
  | "models"
  | "claudeSession"
  | "governance";

interface StepDef {
  key: StepKey;
  title: string;
  optional?: boolean;
  done: (s: SetupState) => boolean;
}

const STEPS: StepDef[] = [
  {
    // Identity = who you are. gcloud + GitHub prove that and unlock creating an org
    // and browsing projects/repos. ADC (application-default credentials) is NOT part
    // of identity — it's only needed to EXECUTE provisioning workflows, so it must
    // not block step 1. ADC gates the cloud-provisioning steps instead (see below).
    key: "auth",
    title: "Connect gcloud + GitHub (your identity)",
    done: (s) => s.auth.gcloud === "ok" && s.auth.gh === "ok",
  },
  { key: "org", title: "Create Org (you = owner)", done: (s) => s.org.present },
  // Create your companies (product units) first-class in the flow — the cloud/repo
  // steps below bind to these. No /onboarding detour, no seeded demo agent.
  { key: "companies", title: "Create companies", done: (s) => s.companies.count > 0 },
  // NOTE: ADC (s.auth.adc === "ok") gates PROVISIONING — the actual execution of the
  // APEX workflows behind the cloud steps below (via LocalRunner). Today these steps
  // only record project/repo bindings (no execution), so ADC isn't in their `done`
  // predicates yet; wire ADC as a precondition here when the one-plan→approve
  // execution path lands, so provisioning can't run without live credentials.
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
  {
    key: "models",
    title: "Models — how judges get paid for and routed",
    done: (s) =>
      s.models != null &&
      (s.models.claude.subscriptionProviderRegistered || s.models.claude.apiKeyProviderRegistered) &&
      s.models.aliasesRegistered.length > 0,
  },
  {
    key: "claudeSession",
    title: "Connect Claude subscription (remote sessions)",
    done: (s) => s.claudeSession?.connected === true,
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
  "companies",
  "orgCloud",
  "orgGithub",
  "companyCloud",
  "companyRepos",
  "oauthClient",
  "gateway",
  "mcpServers",
  "connect",
  "claudeSession",
]);

/** Roles that DON'T provision/execute → cloud steps don't apply.
 *  reviewer/observer are placeholders for the read-only tiers (not yet mintable). */
function roleNeedsCloud(role?: string): boolean {
  return role !== "reviewer" && role !== "observer";
}

/**
 * The HARDENING steps — org-level App-install + Workload Identity Federation.
 * They're the governed, admin-authoritative boundary and only apply once the org
 * dials its governance posture up to `team`/`enterprise`. Under the default
 * `individual` posture (solo dev on personal repos + personal GCP projects) they
 * are OPTIONAL — not required, not blocking "setup complete". (Don't hardcode
 * "everyone needs the App/WIF governance.")
 */
const HARDENING_STEP_KEYS = new Set<StepKey>(["orgGithub"]);

/** Posture that turns on the heavy governance (App-install/WIF/admin binding). */
function postureNeedsHardening(posture?: string): boolean {
  return posture === "team" || posture === "enterprise";
}

/** Steps that count toward "required" given the actor's role AND the org's
 *  governance posture (individual skips the hardening steps). */
function requiredSteps(s: SetupState): StepDef[] {
  const needsCloud = roleNeedsCloud(s.membership?.role);
  const needsHardening = postureNeedsHardening(s.org.posture);
  return STEPS.filter((st) => {
    if (st.optional) return false;
    if (CLOUD_STEP_KEYS.has(st.key) && !needsCloud) return false;
    if (HARDENING_STEP_KEYS.has(st.key) && !needsHardening) return false;
    return true;
  });
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
  // Non-optional but not required here. A hardening step under `individual`
  // posture reads as "optional" (dial up posture to require it); a cloud step
  // skipped for a reviewer/observer role reads as "skipped".
  if (!isRequired) {
    const optionalByPosture =
      HARDENING_STEP_KEYS.has(step.key) && !postureNeedsHardening(state.org.posture);
    return {
      label: optionalByPosture ? "optional" : "skipped",
      variant: "default",
      icon: "pending",
    };
  }
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
    case "companies":
      // Create your companies first-class in the flow (no /onboarding detour, no
      // seeded demo agent) — the cloud/repo steps below bind to these.
      return !orgPresent ? (
        <p className="text-sm text-muted-foreground">
          Create the Org first (step above) — then add your companies here.
        </p>
      ) : (
        <CompanyCreateStep />
      );
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
      // Bind each company's own GCP projects (dev/staging/prod) at company scope.
      // No fixed companyId — the section shows a per-company picker so multi-company
      // binding is explicit in the flow (not tied to the nav's selected company).
      return !orgPresent ? (
        <p className="text-sm text-muted-foreground">
          Create the Org first — company scoping cascades under it.
        </p>
      ) : (
        <OrgScopingSection slice="companyScope" />
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
        <OrgScopingSection slice="companyScope" />
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
    case "models":
      return <ModelsStep onRecheck={onRecheck} rechecking={rechecking} />;
    case "claudeSession":
      return (
        <ClaudeSessionStep
          companyId={selectedCompanyId}
          done={done}
          onRecheck={onRecheck}
          rechecking={rechecking}
        />
      );
    case "governance":
      return <GuidedStep done={done} onRecheck={onRecheck} rechecking={rechecking} />;
  }
}

/** The desktop bridge, when the cockpit renders inside the APEX desktop app. */
type ApexDesktopBridge = {
  claudeConnect?: {
    start: (opts: { companyId: string }) => Promise<{ ok: boolean; error?: string }>;
  };
};

/**
 * The annual Claude-subscription ceremony step. Inside the desktop app the
 * button triggers the whole guided flow in-app (main process spawns
 * `apex claude connect`, opens its page); in a plain browser it falls back to
 * the copy-paste command. The two consent acts stay human either way.
 */
function ClaudeSessionStep({
  companyId,
  done,
  onRecheck,
  rechecking,
}: {
  companyId: string | null;
  done: boolean;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const bridge = (window as unknown as { apexDesktop?: ApexDesktopBridge }).apexDesktop;
  const canTrigger = Boolean(bridge?.claudeConnect && companyId);
  const [startError, setStartError] = useState<string | null>(null);
  const command = `apex claude connect --cockpit-url ${window.location.origin} --company-id ${companyId ?? "<company>"}`;
  return (
    <div className="space-y-3">
      {canTrigger && (
        <Button
          size="sm"
          variant={done ? "outline" : "default"}
          onClick={() => {
            setStartError(null);
            void bridge!.claudeConnect!.start({ companyId: companyId! }).then((r) => {
              if (!r.ok) setStartError(r.error ?? "failed to start");
            });
          }}
        >
          Connect Claude subscription…
        </Button>
      )}
      {startError && <p className="text-xs text-rose-500">{startError}</p>}
      <GuidedStep command={canTrigger ? undefined : command} done={done} onRecheck={onRecheck} rechecking={rechecking} />
    </div>
  );
}

/**
 * The inline "Create companies" step — creates product-unit companies directly in
 * the setup flow (via the org's create+associate route), so there's no detour to
 * the off-brand `/onboarding` wizard and NO seeded Reflection Coach. Creating a
 * company invalidates the detector so it appears live and the cloud/repo steps
 * unlock.
 */
function CompanyCreateStep() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const orgsQuery = useQuery({ queryKey: ["apex-orgs"], queryFn: () => orgsApi.list() });
  const org = orgsQuery.data?.orgs[0] ?? null;
  const companiesQuery = useQuery({
    queryKey: ["apex-org-companies", org?.id],
    queryFn: () => orgsApi.companies(org!.id),
    enabled: !!org,
  });
  const companies = companiesQuery.data?.companies ?? [];
  const createCompany = useMutation({
    mutationFn: (n: string) => orgsApi.createCompany(org!.id, n),
    onSuccess: () => {
      setName("");
      void queryClient.invalidateQueries({ queryKey: ["apex-org-companies", org?.id] });
      // Company count feeds the detector (this step + the company cloud/repo steps
      // + the status bar) — refresh live, not on reload.
      void queryClient.invalidateQueries({ queryKey: ["setup-state"] });
    },
  });

  if (!org) {
    return <p className="text-sm text-muted-foreground">Create the Org first.</p>;
  }

  return (
    <div className="space-y-3" data-testid="apex-companies-step">
      <div className="flex flex-wrap items-center gap-2">
        <input
          data-testid="apex-company-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim() && !createCompany.isPending) {
              createCompany.mutate(name.trim());
            }
          }}
          placeholder="Company name (e.g. FinPilot)"
          className="w-56 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none"
        />
        <Button
          size="sm"
          data-testid="apex-company-create"
          onClick={() => createCompany.mutate(name.trim())}
          disabled={createCompany.isPending || name.trim().length === 0}
        >
          {createCompany.isPending ? "Creating…" : "Create company"}
        </Button>
      </div>
      {createCompany.isError && (
        <span className="text-xs text-destructive">
          {createCompany.error instanceof Error ? createCompany.error.message : "Failed to create company"}
        </span>
      )}
      {companies.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" data-testid="apex-companies-list">
          {companies.map((c) => (
            <StatusBadge key={c.id} variant="info">
              {c.name}
            </StatusBadge>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No companies yet — create your first (e.g. APEX, FinPilot, Bloom).
        </p>
      )}
    </div>
  );
}

/**
 * The "Models" setup step (APEX-115).
 *
 * Default path: detect a logged-in local `claude` CLI → provision the
 * subscription bridge + apex-* aliases with one click. Zero credentials
 * needed: the OAuth token stays in the OS keychain and never touches the
 * gateway's encrypted store.
 *
 * Advanced path: paste a Claude API key (metered, enables per-token cost
 * attribution) or an OpenRouter key (BYO-plane proof).
 */
function ModelsStep({ onRecheck, rechecking }: { onRecheck: () => void; rechecking: boolean }) {
  const queryClient = useQueryClient();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [claudeKey, setClaudeKey] = useState("");
  const [orKey, setOrKey] = useState("");

  const stateQuery = useQuery({
    queryKey: ["setup-state"],
    queryFn: () => setupStateApi.get(),
  });
  const models = stateQuery.data?.models;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["setup-state"] });
    onRecheck();
  };

  const provisionSubscription = useMutation({
    mutationFn: () => setupModelsApi.provisionSubscription(),
    onSuccess: invalidate,
  });

  const provisionApiKey = useMutation({
    mutationFn: () => setupModelsApi.provisionApiKey(claudeKey.trim()),
    onSuccess: () => { setClaudeKey(""); invalidate(); },
  });

  const provisionOpenRouter = useMutation({
    mutationFn: () => setupModelsApi.provisionOpenRouter(orKey.trim()),
    onSuccess: () => { setOrKey(""); invalidate(); },
  });

  const modeLabel = (mode: string | undefined) => {
    if (mode === "subscription_local") return "Local claude CLI (logged in)";
    if (mode === "subscription_remote") return "Remote subscription token";
    if (mode === "api_key") return "ANTHROPIC_API_KEY";
    return "Not detected";
  };

  const bridgeReady =
    models?.claude.subscriptionProviderRegistered || models?.claude.apiKeyProviderRegistered;
  const aliasesReady = (models?.aliasesRegistered.length ?? 0) > 0;

  return (
    <div className="space-y-4" data-testid="apex-models-step">
      {/* Status row */}
      <div className="space-y-1 text-sm">
        <div className="flex items-center gap-2">
          {models?.claude.installed ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
          )}
          <span className="text-muted-foreground">
            claude CLI: {models?.claude.installed ? "installed" : "not found"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {models && models.claude.mode !== "none" ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
          )}
          <span className="text-muted-foreground">
            Claude auth: {modeLabel(models?.claude.mode)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {bridgeReady ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
          )}
          <span className="text-muted-foreground">
            Gateway provider: {bridgeReady ? "registered" : "not provisioned"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {aliasesReady ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
          )}
          <span className="text-muted-foreground">
            apex-* aliases: {aliasesReady ? `${models!.aliasesRegistered.length} seeded` : "not seeded"}
          </span>
        </div>
      </div>

      {/* Default path — subscription bridge */}
      {!bridgeReady && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Default: uses your logged-in <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">claude</code> CLI to provision
            a subscription bridge — no credentials entered anywhere.
          </p>
          <Button
            size="sm"
            data-testid="apex-models-provision-subscription"
            onClick={() => provisionSubscription.mutate()}
            disabled={provisionSubscription.isPending}
          >
            {provisionSubscription.isPending ? "Provisioning…" : "Provision subscription bridge"}
          </Button>
          {provisionSubscription.isError && (
            <p className="text-xs text-destructive">
              {provisionSubscription.error instanceof Error
                ? provisionSubscription.error.message
                : "Provisioning failed"}
            </p>
          )}
          {provisionSubscription.isSuccess && (
            <p className="text-xs text-emerald-600">
              Bridge provisioned — checking state…
            </p>
          )}
        </div>
      )}

      {bridgeReady && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={invalidate} disabled={rechecking}>
            {rechecking ? "Rechecking…" : "Recheck state"}
          </Button>
          {!aliasesReady && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => provisionSubscription.mutate()}
              disabled={provisionSubscription.isPending}
            >
              {provisionSubscription.isPending ? "Seeding…" : "Re-seed aliases"}
            </Button>
          )}
        </div>
      )}

      {/* Advanced path — toggle */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {showAdvanced ? "Hide" : "Advanced"}: Claude API key / OpenRouter
        </button>

        {showAdvanced && (
          <div className="mt-3 space-y-4">
            {/* Claude API key */}
            <div className="space-y-2">
              <p className="text-xs font-medium">Claude API key (metered — enables per-token cost attribution)</p>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={claudeKey}
                  onChange={(e) => setClaudeKey(e.target.value)}
                  placeholder="sk-ant-…"
                  className="w-56 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none"
                  data-testid="apex-models-claude-api-key-input"
                />
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="apex-models-provision-claude-api-key"
                  onClick={() => provisionApiKey.mutate()}
                  disabled={provisionApiKey.isPending || !claudeKey.trim()}
                >
                  {provisionApiKey.isPending ? "Saving…" : "Save key"}
                </Button>
              </div>
              {provisionApiKey.isError && (
                <p className="text-xs text-destructive">
                  {provisionApiKey.error instanceof Error ? provisionApiKey.error.message : "Failed"}
                </p>
              )}
              {provisionApiKey.isSuccess && (
                <p className="text-xs text-emerald-600">API key provider registered.</p>
              )}
              <p className="text-xs text-muted-foreground">
                The key is forwarded ONLY to the gateway's encrypted store — the cockpit never persists it.
              </p>
            </div>

            {/* OpenRouter */}
            <div className="space-y-2">
              <p className="text-xs font-medium">OpenRouter key (BYO-plane — non-Claude models)</p>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={orKey}
                  onChange={(e) => setOrKey(e.target.value)}
                  placeholder="sk-or-…"
                  className="w-56 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none"
                  data-testid="apex-models-openrouter-key-input"
                />
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="apex-models-provision-openrouter"
                  onClick={() => provisionOpenRouter.mutate()}
                  disabled={provisionOpenRouter.isPending || !orKey.trim()}
                >
                  {provisionOpenRouter.isPending ? "Saving…" : "Save key"}
                </Button>
              </div>
              {provisionOpenRouter.isError && (
                <p className="text-xs text-destructive">
                  {provisionOpenRouter.error instanceof Error ? provisionOpenRouter.error.message : "Failed"}
                </p>
              )}
              {provisionOpenRouter.isSuccess && (
                <p className="text-xs text-emerald-600">
                  OpenRouter registered — apex-* aliases remain on Claude subscription.
                </p>
              )}
              {models?.openrouter.configured && (
                <p className="text-xs text-emerald-600">OpenRouter: already configured.</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
