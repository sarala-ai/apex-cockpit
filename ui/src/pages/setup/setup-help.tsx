// Setup wizard — per-step help content + presentation (apex-tower onboarding).
//
// Explanatory prose lives HERE, not in the step rows. Each step's guidance is
// structured data (`purpose` + ordered `whatYoullDo` + optional `note`/`links`),
// rendered consistently in the right-hand help rail (wide screens) or an ⓘ
// popover (narrow). Step rows stay tight — actions only. Keeping the copy as data
// (not JSX buried in the wizard) makes it easy to keep professional and terse.

import type { ReactNode } from "react";
import { ExternalLink, Info } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StepKey } from "./SetupWizard";

export interface StepHelp {
  /** One-line statement of what the step is for. */
  purpose: string;
  /** Short ordered list of the concrete actions. */
  whatYoullDo: string[];
  /** Optional caveat / important detail, rendered as a subtle callout. */
  note?: string;
  /** Optional reference links (opened in a new tab). */
  links?: { label: string; href: string }[];
}

/** Render `backtick`-delimited spans as inline <code>, everything else as text. */
function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded bg-muted px-1 py-0.5 text-xs">
        {part.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export const STEP_HELP: Record<StepKey, StepHelp> = {
  claudeSession: {
    purpose:
      "Remote sandbox sessions run claude AS YOU, on your Claude subscription. Anthropic requires a human consent for that credential — a ~60-second ceremony, once a year.",
    whatYoullDo: [
      "In the APEX desktop app: click Connect Claude subscription — the whole ceremony runs right here. Open the Anthropic page, approve, paste the shown code into the field below.",
      "In a plain browser instead: run `apex claude connect --cockpit-url <this cockpit> --company-id <company>` in your own terminal and follow its page (it adds one cockpit CLI-access approval).",
      "This step flips to done automatically — the token lands in YOUR per-user secret slot and is injected per-run, then destroyed with each session.",
    ],
    note: "The paste-back is Anthropic's consent design for a year-long subscription token — it stays manual on purpose; everything around it is automated. Metered alternative: a company ANTHROPIC_API_KEY also satisfies this step.",
  },
  auth: {
    purpose:
      "APEX is tied to your Google Cloud and GitHub identities — connect both to begin.",
    whatYoullDo: [
      "Open the APEX desktop app: it reports your gcloud/GitHub/ADC state and offers Sign in to Google Cloud.",
      "Terminal-first? Run `apex doctor --report` to send the same report from the command line.",
      "GitHub connect isn't in-app yet — run `apex connect github`.",
    ],
    note: "Discovery and the Artifact Registry pull read your local gcloud / gh credentials.",
  },
  org: {
    purpose:
      "Create the holding Org. On an empty instance its creator becomes the owner; later users are approved by an owner.",
    whatYoullDo: [
      "Name the Org (e.g. Sarala).",
      "Map it to a GitHub org so repo pickers show the org's repos, not your personal ones.",
      "Create it — you are recorded as owner (active).",
    ],
  },
  companies: {
    purpose:
      "Create your companies (product units, e.g. APEX / FinPilot / Bloom) — first-class here, so the cloud and repo steps below have something to bind to.",
    whatYoullDo: [
      "Name a company and create it — it's associated to the Org automatically.",
      "Repeat for each product unit.",
      "Then bind each company's GCP projects and repos in the steps below.",
    ],
    note: "Created clean in-flow — no `/onboarding` detour and no seeded demo agent.",
  },
  orgCloud: {
    purpose:
      "Bind the shared GCP projects every company draws on — CI/CD, Artifact Registry, shared Secret Manager, observability.",
    whatYoullDo: [
      "Select the org's shared GCP projects.",
      "Optionally select shared repos at org scope.",
      "Save the binding — it seeds the org → company → project resolver cascade.",
    ],
  },
  companyCloud: {
    purpose:
      "Associate this company's GCP projects (dev / staging / prod) so its view shows them and deploys can target them.",
    whatYoullDo: [
      "Select the company's GCP projects (naming-matched projects are suggested).",
      "Save — it's a loose, editable association.",
    ],
    note: "This is an organizing label / deploy target, NOT an access grant — who can actually touch a project is governed by GCP IAM (local) and Workload Identity Federation (cloud).",
  },
  companyRepos: {
    purpose: "Pick the repos this company owns, from the org's repos.",
    whatYoullDo: [
      "Select this company's repos.",
      "Save — the per-repo(+env) deploy-SA WIF bindings (see Org GitHub) are generated from this company ↔ repo grouping.",
    ],
  },
  oauthClient: {
    purpose:
      "This step checks two things: the cockpit's own Google sign-in client (`GOOGLE_CLIENT_ID`) and whether the gateway's registered OAuth-typed upstreams carry an OAuth config. One Google OAuth client (Web app) backs both SSO and per-user Workspace access — you consent to your own account later, no service account, no delegation.",
    whatYoullDo: [
      "Enable the `gmail`, `docs`, `sheets`, and `drive` APIs in the project.",
      "Set the OAuth consent screen to Internal (sarala.ai). Scopes: `openid`, `userinfo.email`, `userinfo.profile` (identity / SSO); `gmail.modify`; `documents`; `spreadsheets`; `drive.file`.",
      "Create one OAuth 2.0 Client (Web application). Redirect URIs: `http://localhost:8001/oauth2callback` (dev) plus your planned cloud URL.",
      "Copy the client id + secret; store the secret in Secret Manager (the APEX workflow does this).",
    ],
    note: "Enabling APIs + creating the client are scriptable via the APEX workflow; the consent screen has a console step. The API path needs the `iam.oauthClientAdmin` role.",
    links: [
      { label: "Open GCP Credentials", href: "https://console.cloud.google.com/apis/credentials" },
    ],
  },
  gateway: {
    purpose:
      "The apex-gateway (ContextForge MCP gateway) URL is set by the deployment, not by you — the wizard shows it and detects reachability + credential trust.",
    whatYoullDo: [
      "Unreachable means the gateway deployment is down — that's a deployment fix, not a local process to start.",
      "Credential rejected means the gateway does not trust this cockpit's issuer (JWKS trust) — also a deployment fix.",
    ],
  },
  mcpServers: {
    purpose:
      "Register the MCP servers whose tools your agents should see (e.g. Google Workspace). The gateway federates their tools into one catalog.",
    whatYoullDo: [
      "Register an upstream MCP server: POST /gateways with its endpoint + transport.",
      "The gateway auto-connects, lists its tools, and federates them.",
    ],
  },
  connect: {
    purpose:
      "Authorize your own Google account once (per-user OAuth via the gateway broker). No service account, no delegation — you authorize you.",
    whatYoullDo: [
      "Start the per-user OAuth flow for the Workspace gateway and approve consent in the browser.",
      "The broker stores your token; the wizard detects the connection.",
    ],
  },
  models: {
    purpose:
      "Answer 'how do model calls get paid for and routed here' — provision the subscription bridge (default) or wire an API key (advanced).",
    whatYoullDo: [
      "On a local cockpit: the default subscription bridge uses the `claude` CLI logged in on that machine — click 'Provision subscription bridge'. The cockpit starts an OpenAI-compatible shim backed by `claude -p`; the gateway gets a provider row and `apex-*` aliases pointing at it.",
      "On a hosted cockpit: the bridge isn't available — model calls use the connected Claude session (the next step) or an API key (below).",
      "Advanced (Claude API key): paste a `sk-ant-…` key — it goes ONLY into the gateway's encrypted store, the cockpit never persists it. Enables per-token cost attribution (Costs page).",
      "Advanced (OpenRouter): paste a `sk-or-…` key to register a BYO-plane provider. Existing `apex-*` aliases stay on Claude subscription; OpenRouter is available as an additional provider.",
    ],
    note: "Subscription mode uses the Claude Agent SDK under the hood (`claude -p`), which is the sanctioned path for OAuth tokens — the token is NEVER used as a raw chat-completions API key. Trade-off: no per-token cost metering in subscription mode (metering arrives only in API-key mode).",
  },
  governance: {
    purpose:
      "Optional: allowlist which federated tools each company / agent may use — the resolver cascade applied to the catalog.",
    whatYoullDo: ["Scope the federated tool catalog per org / company / agent, once tools are federated."],
  },
};

/** The structured help body — shared by the rail and the ⓘ popover. */
export function StepHelpContent({ help }: { help: StepHelp }) {
  return (
    <div className="space-y-3 text-sm" data-testid="wizard-help-content">
      <p className="text-muted-foreground">{renderInline(help.purpose)}</p>

      {help.whatYoullDo.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            What you'll do
          </div>
          <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
            {help.whatYoullDo.map((s, i) => (
              <li key={i}>{renderInline(s)}</li>
            ))}
          </ol>
        </div>
      )}

      {help.note && (
        <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          {renderInline(help.note)}
        </p>
      )}

      {help.links && help.links.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {help.links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
            >
              <ExternalLink className="h-3 w-3" />
              {l.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The sticky right-hand help panel (wide screens). Shows guidance for the focused
 * step — the expanded/active step by default, or whichever step's ⓘ was clicked.
 */
export function HelpRail({ title, help }: { title?: string; help?: StepHelp }) {
  return (
    <Card data-testid="wizard-help-rail">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <Info className="h-4 w-4 text-muted-foreground" />
          {title ?? "Guidance"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {help ? (
          <StepHelpContent help={help} />
        ) : (
          <p className="text-sm text-muted-foreground">Select a step to see its guidance.</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The per-row ⓘ affordance. On wide screens it focuses the help rail on this
 * step; on narrow screens (rail hidden) it opens the same content in a popover.
 * Both variants are keyboard-accessible and stop row-toggle propagation.
 */
export function StepInfo({
  stepKey,
  title,
  help,
  onFocusRail,
}: {
  stepKey: StepKey;
  title: string;
  help: StepHelp;
  onFocusRail: () => void;
}) {
  const iconClass =
    "inline-flex items-center justify-center rounded p-0.5 text-muted-foreground/70 transition hover:text-foreground focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none";
  return (
    <>
      {/* Wide: focus the rail on this step. */}
      <button
        type="button"
        aria-label={`Show help for ${title}`}
        data-testid={`wizard-help-info-${stepKey}`}
        onClick={(e) => {
          e.stopPropagation();
          onFocusRail();
        }}
        className={`hidden lg:inline-flex ${iconClass}`}
      >
        <Info className="h-3.5 w-3.5" />
      </button>

      {/* Narrow: same content in a popover. */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Show help for ${title}`}
            data-testid={`wizard-help-info-sm-${stepKey}`}
            onClick={(e) => e.stopPropagation()}
            className={`lg:hidden ${iconClass}`}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-80"
          data-testid="wizard-help-popover"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-2 text-sm font-medium">{title}</div>
          <StepHelpContent help={help} />
        </PopoverContent>
      </Popover>
    </>
  );
}
