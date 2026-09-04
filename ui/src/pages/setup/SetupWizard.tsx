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
import { timeAgo } from "../../lib/timeAgo";

// The cloud-first org→company engineering-setup spine. ORG steps (identity →
// create org → org cloud → org GitHub) provision the shared substrate; COMPANY
// steps (company cloud → company repos) provision each product unit; then the
// capability layer (OAuth client → gateway → MCP → connect → models → governance).
export type StepKey =
  | "auth"
  | "org"
  | "companies"
  | "orgCloud"
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
    done: (s) => s.auth.gcloud === "ok" && s.auth.gh === "ok" && s.auth.source !== "stale",
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
    key: "companyCloud",
    title: "Company cloud — GCP projects",
    done: (s) => s.companies.count > 0 && s.scoping.companyProjectsBound,
  },
  {
    key: "companyRepos",
    title: "Company repos",
    done: (s) => s.companies.count > 0 && s.scoping.companyReposBound,
  },
  {
    key: "oauthClient",
    title: "Google OAuth — cockpit sign-in + gateway upstreams",
    done: (s) => s.oauthClient.configured,
  },
  {
    key: "gateway",
    title: "MCP gateway running",
    done: (s) => s.gateway.reachable && s.gateway.authenticated === true,
  },
  {
    key: "mcpServers",
    title: "MCP servers registered",
    done: (s) => s.mcpServers.registered.length > 0,
  },
  {
    key: "connect",
    title: "Connect capability (your Google consent)",
    done: (s) => s.oauthClient.configured && s.mcpServers.registered.length > 0 && !s.mcpServers.error,
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

/** Steps that count toward "required" given the actor's role. */
function requiredSteps(s: SetupState): StepDef[] {
  const needsCloud = roleNeedsCloud(s.membership?.role);
  return STEPS.filter((st) => {
    if (st.optional) return false;
    if (CLOUD_STEP_KEYS.has(st.key) && !needsCloud) return false;
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
  // Non-optional but not required here — a cloud step skipped for a
  // reviewer/observer role reads as "skipped".
  if (!isRequired) {
    return { label: "skipped", variant: "default", icon: "pending" };
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
  const authReady =
    state != null && state.auth.gcloud === "ok" && state.auth.gh === "ok" && state.auth.source !== "stale";

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
      <div className="lg:flex lg:items-start lg:gap-4">
        <Card className="lg:min-w-0 lg:flex-1">
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
                          state={state}
                          selectedCompanyId={selectedCompanyId}
                          orgId={state.org.id ?? null}
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
        <div className="hidden lg:sticky lg:top-4 lg:block lg:w-80 lg:shrink-0">
          <HelpRail title={railStep?.title} help={railStep ? STEP_HELP[railStep.key] : undefined} />
        </div>
      </div>
    </div>
  );
}

function StepBody({
  stepKey,
  state,
  selectedCompanyId,
  orgId,
  orgPresent,
  done,
  authReady,
  onRecheck,
  rechecking,
}: {
  stepKey: StepKey;
  state: SetupState;
  selectedCompanyId: string | null;
  orgId: string | null;
  orgPresent: boolean;
  done: boolean;
  authReady: boolean;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  // Identity is the hard gate — every org/cloud-scoped step is blocked until
  // gcloud + gh are both green. The identity step itself is never gated.
  // The Claude ceremony's identity requirement is the signed-in cockpit
  // session itself (the device-auth approval proves it) — not the machine's
  // gcloud/gh state, which on a cloud cockpit describes the SERVER anyway.
  if (stepKey !== "auth" && stepKey !== "claudeSession" && !authReady) {
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
    case "oauthClient": {
      const signInLabel =
        state.oauthClient.signInClient === "configured"
          ? "configured"
          : state.oauthClient.signInClient === "not_applicable"
            ? "not needed on a local instance"
            : "missing";
      const upstreams = state.oauthClient.gatewayUpstreams;
      return (
        <div className="space-y-3">
          <div className="space-y-1 text-sm text-muted-foreground">
            <div>Sign-in client: {signInLabel}</div>
            <div>
              {upstreams.error
                ? `Gateway OAuth upstreams: ${upstreams.error}`
                : `Gateway OAuth upstreams: ${upstreams.configured} of ${upstreams.total} configured`}
            </div>
          </div>
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
        </div>
      );
    }
    case "gateway": {
      const gw = state.gateway;
      let toneClass = "";
      let message = "";
      if (!gw.reachable) {
        toneClass = "border-amber-500/30 bg-amber-500/10 text-amber-600";
        message = `apex-gateway at ${gw.url} is unreachable`;
      } else if (gw.failure && (gw.failure.kind === "unauthenticated" || gw.failure.kind === "forbidden")) {
        toneClass = "border-red-500/30 bg-red-500/10 text-red-600";
        message = `apex-gateway at ${gw.url} answered but rejected the cockpit's credential: ${gw.failure.message}`;
      } else if (gw.failure) {
        toneClass = "border-amber-500/30 bg-amber-500/10 text-amber-600";
        message = gw.failure.message;
      } else {
        toneClass = "border-emerald-500/30 bg-emerald-500/10 text-emerald-600";
        message = "reachable, credential accepted";
      }
      return (
        <div className="space-y-3">
          <code className="block w-fit rounded bg-muted px-2 py-1 text-xs">{gw.url}</code>
          <div className={`rounded-md border px-3 py-2 text-sm ${toneClass}`}>{message}</div>
          <GuidedStep done={done} onRecheck={onRecheck} rechecking={rechecking} />
        </div>
      );
    }
    case "mcpServers":
      return <McpServersStep state={state} done={done} onRecheck={onRecheck} rechecking={rechecking} />;
    case "connect":
      return <GuidedStep done={done} onRecheck={onRecheck} rechecking={rechecking} />;
    case "models":
      return <ModelsStep onRecheck={onRecheck} rechecking={rechecking} />;
    case "claudeSession":
      return (
        <ClaudeSessionStep
          orgId={orgId}
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

/** The ceremony state stream from `apex claude connect --emit-json`, relayed by the desktop. */
type ClaudeConnectState = {
  cockpit_approved: boolean;
  cockpit_approval_url?: string | null;
  anthropic_url: string | null;
  attempt_error: string | null;
  delivered: boolean;
  error: string | null;
};

/** The desktop bridge, when the cockpit renders inside the APEX desktop app. */
type ApexDesktopBridge = {
  claudeConnect?: {
    start: (opts: { orgId?: string; companyId?: string }) => Promise<{ ok: boolean; error?: string }>;
    submitCode?: (code: string) => Promise<{ ok: boolean; error?: string }>;
    cancel?: () => Promise<{ ok: boolean }>;
    onState?: (listener: (state: ClaudeConnectState) => void) => () => void;
    onExit?: (listener: (info: { code: number | null }) => void) => () => void;
  };
};

/**
 * The annual Claude-subscription ceremony step. Inside the desktop app the
 * whole flow runs INLINE here — one surface: the Anthropic link is a button,
 * the code paste is a field, delivery flips the step. The desktop's main
 * process drives `apex claude connect --emit-json` underneath. In a plain
 * browser (or an older desktop without the inline bridge) it falls back to
 * the copy-paste command. The two consent acts stay human either way.
 */
export function ClaudeSessionStep({
  orgId,
  companyId,
  done,
  onRecheck,
  rechecking,
}: {
  orgId?: string | null;
  companyId: string | null;
  done: boolean;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const bridge = (window as unknown as { apexDesktop?: ApexDesktopBridge }).apexDesktop;
  const connect = bridge?.claudeConnect;
  const inline = Boolean(connect?.submitCode && connect?.onState && (orgId || companyId));
  const [phase, setPhase] = useState<"idle" | "running" | "delivered" | "failed">("idle");
  const [state, setState] = useState<ClaudeConnectState | null>(null);
  const [code, setCode] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const command = orgId
    ? `apex claude connect --cockpit-url ${window.location.origin} --org-id ${orgId}`
    : `apex claude connect --cockpit-url ${window.location.origin} --company-id ${companyId ?? "<company>"}`;

  useEffect(() => {
    if (!inline) return;
    const offState = connect!.onState!((st) => {
      setState(st);
      if (st.delivered) {
        setPhase("delivered");
        onRecheck();
      } else if (st.error) {
        setPhase("failed");
      }
    });
    const offExit = connect!.onExit?.(({ code: exitCode }) => {
      // A non-zero exit without a terminal state means the CLI died mid-flow.
      setPhase((p) => (p === "running" && exitCode !== 0 ? "failed" : p === "running" ? "idle" : p));
    });
    return () => {
      offState();
      offExit?.();
    };
  }, [inline]);

  const start = () => {
    setStartError(null);
    setState(null);
    setCode("");
    setSubmitted(false);
    setPhase("running");
    void connect!.start(orgId ? { orgId } : { companyId: companyId! }).then((r) => {
      if (!r.ok) {
        setStartError(r.error ?? "failed to start");
        setPhase("failed");
      }
    });
  };

  const submit = () => {
    if (!code.trim()) return;
    void connect!.submitCode!(code).then((r) => {
      if (!r.ok) setStartError(r.error ?? "could not submit the code");
      else setSubmitted(true);
    });
  };

  const cancel = () => {
    void connect!.cancel?.();
    setPhase("idle");
    setState(null);
  };

  if (!inline) {
    return <GuidedStep command={command} done={done} onRecheck={onRecheck} rechecking={rechecking} />;
  }

  const running = phase === "running";
  const anthropicUrl = state?.anthropic_url ?? null;

  return (
    <div className="space-y-3 text-sm" data-testid="claude-session-step">
      {(phase === "idle" || phase === "failed") && (
        <Button size="sm" variant={done ? "outline" : "default"} onClick={start} data-testid="claude-connect-start">
          {phase === "failed" ? "Try again" : done ? "Reconnect Claude subscription…" : "Connect Claude subscription…"}
        </Button>
      )}

      {phase !== "idle" && (
        <ol className="space-y-2 rounded-md border border-border p-3">
          <li className="flex items-center gap-2">
            <span className="text-muted-foreground">1.</span>
            <span>Cockpit access</span>
            {state?.cockpit_approved ? (
              <span className="text-xs text-emerald-500">approved ✓</span>
            ) : state?.cockpit_approval_url ? (
              <a href={state.cockpit_approval_url} target="_blank" rel="noreferrer" className="text-xs underline">
                approve in the browser
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">{running ? "starting…" : ""}</span>
            )}
          </li>
          <li className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">2.</span>
            <span>Authorize with Anthropic</span>
            {anthropicUrl ? (
              <a href={anthropicUrl} target="_blank" rel="noreferrer">
                <Button size="sm" variant="outline" data-testid="claude-connect-anthropic">
                  Open Anthropic page
                </Button>
              </a>
            ) : (
              <span className="text-xs text-muted-foreground">
                {state?.cockpit_approved ? "starting claude setup-token…" : "waiting for step 1…"}
              </span>
            )}
            {anthropicUrl && <span className="text-xs text-muted-foreground">approve, then copy the code shown</span>}
          </li>
          <li className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">3.</span>
              <span>Paste the code</span>
              <span className="text-xs text-muted-foreground">(extra characters are cleaned automatically)</span>
            </div>
            <div className="flex items-center gap-2 pl-5">
              <input
                data-testid="claude-connect-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
                placeholder="authorization code"
                disabled={!running || !anthropicUrl}
                className="w-80 rounded-md border border-border bg-transparent px-2.5 py-1 font-mono text-xs outline-none disabled:opacity-50"
              />
              <Button size="sm" onClick={submit} disabled={!running || !anthropicUrl || code.trim().length === 0} data-testid="claude-connect-submit">
                Submit
              </Button>
            </div>
            {submitted && !state?.attempt_error && running && (
              <p className="pl-5 text-xs text-muted-foreground">submitted — minting and delivering…</p>
            )}
            {state?.attempt_error && <p className="pl-5 text-xs text-rose-500">{state.attempt_error}</p>}
          </li>
          {phase === "delivered" && (
            <li className="text-xs text-emerald-500" data-testid="claude-connect-delivered">
              Delivered ✓ — your subscription is connected for remote sessions.
            </li>
          )}
          {phase === "failed" && (state?.error || startError) && (
            <li className="text-xs text-rose-500" data-testid="claude-connect-error">
              {state?.error ?? startError}
            </li>
          )}
          {running && (
            <li>
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </li>
          )}
        </ol>
      )}
      {startError && phase !== "failed" && <p className="text-xs text-rose-500">{startError}</p>}
      <GuidedStep done={done} onRecheck={onRecheck} rechecking={rechecking} />
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
 * MCP servers step body. Registration normally happens on its own — boot
 * (once) and the background sweep (registration-sweep.ts, every
 * APEX_MCP_REGISTRATION_SWEEP_SEC) both retry without operator action. The
 * "Register now" button only surfaces when there's evidence it hasn't
 * caught up yet: the registry read errored, or cockpit-mcp is absent from
 * it — so an operator isn't left waiting on the next sweep tick.
 */
export function McpServersStep({
  state,
  done,
  onRecheck,
  rechecking,
}: {
  state: SetupState;
  done: boolean;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const queryClient = useQueryClient();
  const needsRegisterNow = Boolean(state.mcpServers.error) || !state.mcpServers.cockpitMcp.registered;

  const registerNow = useMutation({
    mutationFn: () => setupStateApi.registerCockpitMcp(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["setup-state"] });
      onRecheck();
    },
  });

  return (
    <div className="space-y-3">
      {state.mcpServers.error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
          Registry could not be read: {state.mcpServers.error} — the list below is not an empty registry
        </div>
      )}
      {needsRegisterNow && (
        <div className="space-y-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => registerNow.mutate()}
            disabled={registerNow.isPending}
          >
            {registerNow.isPending ? "Registering…" : "Register now"}
          </Button>
          {registerNow.data && (
            <div className="text-xs text-muted-foreground">
              {registerNow.data.outcome}: {registerNow.data.message}
            </div>
          )}
        </div>
      )}
      <GuidedStep done={done} onRecheck={onRecheck} rechecking={rechecking} />
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
  const bridgeAvailable = models?.bridgeAvailable ?? true;

  const cliLine = (() => {
    if (!models || models.claude.source === "unknown") {
      return `claude CLI: unknown — your workstation hasn't reported (run \`apex doctor --report --cockpit-url ${window.location.origin}\`)`;
    }
    if (models.claude.source === "server") {
      return `claude CLI: ${models.claude.installed ? "installed" : "not found"} (this cockpit host)`;
    }
    const reported = models.claude.reportedAt ? timeAgo(models.claude.reportedAt) : "recently";
    return `claude CLI on your workstation: ${models.claude.installed ? "installed" : "not found"} (reported ${reported})`;
  })();
  const cliKnown = models != null && models.claude.source !== "unknown" && models.claude.installed === true;

  const authLine = (() => {
    if (!models || models.claude.mode === "unknown") return "Claude auth: unknown";
    const label = modeLabel(models.claude.mode);
    if (models.claude.source === "workstation") {
      return `Claude auth: ${label} (logged in on your workstation — that alone doesn't let this cockpit call Claude)`;
    }
    return `Claude auth: ${label}`;
  })();
  const authKnown = models != null && models.claude.mode !== "none" && models.claude.mode !== "unknown";

  return (
    <div className="space-y-4" data-testid="apex-models-step">
      {/* Status row */}
      <div className="space-y-1 text-sm">
        <div className="flex items-center gap-2">
          {cliKnown ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
          )}
          <span className="text-muted-foreground">{cliLine}</span>
        </div>
        <div className="flex items-center gap-2">
          {authKnown ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <Circle className="h-3.5 w-3.5 text-muted-foreground/40" />
          )}
          <span className="text-muted-foreground">{authLine}</span>
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

      {/* Default path — subscription bridge (local cockpit only) */}
      {!bridgeReady && bridgeAvailable && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Default: uses your logged-in <code className="rounded bg-muted px-1 py-0.5 text-xs">claude</code> CLI to provision
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

      {!bridgeAvailable && !bridgeReady && (
        <p className="text-xs text-muted-foreground">
          The subscription bridge runs only on a local cockpit. On this hosted cockpit, model calls
          use your connected Claude session (next step) or an API key (Advanced).
        </p>
      )}

      {bridgeReady && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={invalidate} disabled={rechecking}>
            {rechecking ? "Rechecking…" : "Recheck state"}
          </Button>
          {!aliasesReady && bridgeAvailable && (
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
