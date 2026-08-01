import { useState } from "react";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, GitPullRequest } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { formatCents } from "../lib/utils";
import { approvalsApi, type ApprovalPrDiff } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { formatWaitingFor } from "../lib/approval-waiting";
import { resolveArtifactRenderer } from "./artifact-renderers";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
  flow_gate: "Flow Gate",
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload);
  if (subject) {
    return `${base}: ${subject}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
  flow_gate: GitPullRequest,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Summary</p>
          <p className="leading-6 text-foreground/90">{summary}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{recommendedAction}</p>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">On approval</p>
          <p className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</p>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Proposed comment
          </p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * The artifact block — the PR the reviewer should actually look at.
 *
 * The BODY of this block is not written here. It comes from the
 * artifact-renderer registry, keyed by the `artifactKind` the server
 * classified. Adding a renderer for a new artifact type must require zero
 * edits to this component; if that stops being true, the seam has leaked.
 */
function ArtifactBlock({ artifact }: { artifact: ApprovalPrDiff }) {
  if (artifact.available === false) {
    return <p className="text-xs text-muted-foreground">No linked pull request found for this gate.</p>;
  }
  if (artifact.degraded) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
        Couldn&rsquo;t load {artifact.repo}#{artifact.headBranch}: {artifact.error}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-background/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate font-medium text-foreground hover:underline"
        >
          {artifact.title || `${artifact.repo}#${artifact.headBranch}`}
        </a>
        <span className="shrink-0 text-xs text-muted-foreground">
          <span className="text-green-600 dark:text-green-400">+{artifact.totals.additions}</span>{" "}
          <span className="text-red-600 dark:text-red-400">-{artifact.totals.deletions}</span>{" "}
          · {artifact.totals.changedFiles} file{artifact.totals.changedFiles === 1 ? "" : "s"}
        </span>
      </div>
      <div className="border-t border-border/60 pt-2">
        {resolveArtifactRenderer(artifact).render(artifact)}
      </div>
      {artifact.files_truncated && (
        <p className="text-(length:--text-micro) text-muted-foreground">
          Showing the first {artifact.files.length} changed files — more were truncated.
        </p>
      )}
    </div>
  );
}

function formatStamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

/**
 * Flow-gate approval surface — a DECISION BRIEF, not a log.
 *
 * Founder critique this answers, verbatim: reviewing a flow-gated ticket
 * today means "reviewing agent slop" — the ticket is loaded with machine
 * correspondence and "I don't know what to interpret, where to start and
 * where to end." So the reviewer's eye lands on the decision, then the
 * artifact, and nothing else: sections read in decision order (what is being
 * decided → what was already verified → what to look at → what happens next
 * → who did the work), raw acceptance strings and UUIDs live behind a
 * details affordance, and every section degrades independently because the
 * server assembles them failure-isolated (GET /approvals/:id/brief).
 */
export function FlowGatePayload({
  payload,
  approvalId,
}: {
  payload: Record<string, unknown>;
  approvalId?: string;
}) {
  const prompt = firstNonEmptyString(payload.prompt);
  const [showMachine, setShowMachine] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.approvals.brief(approvalId ?? ""),
    queryFn: () => approvalsApi.getBrief(approvalId as string),
    enabled: !!approvalId,
    staleTime: 15_000,
  });

  if (!approvalId) {
    return prompt ? <p className="mt-3 leading-6 text-sm text-foreground/90">{prompt}</p> : null;
  }
  if (isLoading) {
    return <p className="mt-3 text-xs text-muted-foreground">Preparing the decision brief…</p>;
  }
  if (!data || data.available === false) {
    // No brief (not a flow gate, no issue, or the assembler found nothing) —
    // fall back to the gate's own prompt rather than showing an empty card.
    return (
      <div className="mt-3 space-y-2 text-sm">
        {prompt && <p className="leading-6 text-foreground/90">{prompt}</p>}
        <p className="text-xs text-muted-foreground">
          No decision brief could be assembled for this gate
          {data && "reason" in data && data.reason ? ` (${data.reason})` : ""}.
        </p>
      </div>
    );
  }

  const { decision, verified, artifact, next, risk, provenance, machine } = data;
  const waiting = formatWaitingFor(data.waitingSince);
  const verifiedTone =
    verified.ok === true
      ? "border-emerald-500/25 bg-emerald-500/10"
      : verified.ok === false
        ? "border-red-500/25 bg-red-500/10"
        : "border-border/60 bg-muted/30";
  const machineLines = [
    ...verified.machine,
    machine.flowName ? `flow: ${machine.flowName}` : null,
    machine.nodeId ? `gate node: ${machine.nodeId}` : null,
    provenance.runId ? `run: ${provenance.runId}` : null,
    provenance.agentId ? `agent: ${provenance.agentId}` : null,
    `approval: ${machine.approvalId}`,
    next.note ? `note: ${next.note}` : null,
  ].filter((line): line is string => !!line);

  const who = provenance.agentName ?? (provenance.agentId ? "An agent" : null);
  const stamps = [
    provenance.commissionedAt ? `started ${formatStamp(provenance.commissionedAt)}` : null,
    provenance.gateOpenedAt ? `gate opened ${formatStamp(provenance.gateOpenedAt)}` : null,
  ].filter((line): line is string => !!line);

  return (
    <div className="mt-4 space-y-4 text-sm" data-testid="flow-gate-decision-brief">
      {/* 1 — what is being decided */}
      <div className="space-y-1">
        <SectionLabel>You are deciding</SectionLabel>
        <p className="text-base font-medium leading-6 text-foreground">
          {decision.headline}
          {decision.detail ? <span className="font-normal text-foreground/80"> — {decision.detail}</span> : null}
        </p>
        {decision.subject && (
          <p className="leading-6 text-muted-foreground">
            {decision.ticketIdentifier ? `${decision.ticketIdentifier}: ` : ""}
            {decision.subject}
          </p>
        )}
        {waiting && (
          <p
            className={`text-xs ${waiting.stale ? "font-medium text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
            data-testid="flow-gate-waiting-for"
          >
            {waiting.label}
            {waiting.stale ? " — you are the bottleneck here." : ""}
          </p>
        )}
      </div>

      {/* 2 — what the system already verified */}
      <div className={`rounded-lg border px-3.5 py-3 ${verifiedTone}`}>
        <SectionLabel>Already checked</SectionLabel>
        <p className="mt-1 leading-6 text-foreground">{verified.headline}</p>
      </div>

      {/* 3 — what to look at */}
      <div className="space-y-1.5">
        <SectionLabel>What to look at</SectionLabel>
        <ArtifactBlock artifact={artifact} />
      </div>

      {/* 4 — what happens next (derived from the flow definition), and how
          hard it is to take back. "On approval" / "Risks" deliberately reuse
          the board-approval brief's labels — one vocabulary across every
          approval type, not a second one for flow gates. */}
      <div className="space-y-1.5 rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
        <SectionLabel>On approval</SectionLabel>
        <p className="leading-6 text-foreground">{next.approve}</p>
        <p className="leading-6 text-muted-foreground">{next.reject}</p>
        {risk && (
          <p
            className={`leading-6 ${
              risk.reversibility === "irreversible"
                ? "font-medium text-red-700 dark:text-red-300"
                : risk.reversibility === "reversible_with_effort"
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-muted-foreground"
            }`}
            data-testid="flow-gate-reversibility"
          >
            {risk.reversibilityLine}
          </p>
        )}
      </div>

      {risk && risk.risks.length > 0 && (
        <div className="space-y-1.5" data-testid="flow-gate-risks">
          <SectionLabel>Risks</SectionLabel>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risk.risks.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5 — who / what did the work */}
      {(who || stamps.length > 0 || provenance.permissionProfile) && (
        <p className="text-xs leading-5 text-muted-foreground">
          {who ? <span className="text-foreground/80">{who}</span> : null}
          {who && provenance.permissionProfile ? ` · ${provenance.permissionProfile} permissions` : null}
          {stamps.length > 0 ? `${who || provenance.permissionProfile ? " · " : ""}${stamps.join(" · ")}` : null}
        </p>
      )}

      {/* the machine trail — present, but never the headline */}
      {machineLines.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={showMachine}
            aria-controls={`flow-gate-machine-${machine.approvalId}`}
            onClick={() => setShowMachine((current) => !current)}
            className="text-(length:--text-micro) text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {showMachine ? "Hide technical details" : "Technical details"}
          </button>
          <ul
            id={`flow-gate-machine-${machine.approvalId}`}
            hidden={!showMachine}
            className="mt-1.5 space-y-0.5 rounded-md bg-muted/40 px-3 py-2 font-mono text-(length:--text-micro) text-muted-foreground"
          >
            {machineLines.map((line) => (
              <li key={line} className="break-all">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
  approvalId,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
  approvalId?: string;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  if (type === "flow_gate") return <FlowGatePayload payload={payload} approvalId={approvalId} />;
  return <CeoStrategyPayload payload={payload} />;
}
