import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, GitPullRequest } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { formatCents } from "../lib/utils";
import { approvalsApi } from "../api/approvals";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "./StatusBadge";

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

function PullRequestFileRow({ file }: { file: { path: string; status: string; additions: number; deletions: number } }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      <StatusBadge status={file.status} />
      <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
      <span className="shrink-0 text-muted-foreground">
        <span className="text-green-600 dark:text-green-400">+{file.additions}</span>{" "}
        <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
      </span>
    </li>
  );
}

/**
 * Flow-gate approval payload — the gate's prompt plus the PR the preceding
 * A-node's `pr_exists:<repo>#<head>` acceptance points at, fetched at VIEW
 * time (server/src/routes/approvals.ts GET /approvals/:id/pr-diff) so an
 * already-pending approval benefits the moment this ships, not just new
 * ones. Loading / not-applicable / degraded (CLI or gh unavailable) states
 * are rendered explicitly — the fetch never throws into this component.
 */
export function FlowGatePayload({
  payload,
  approvalId,
}: {
  payload: Record<string, unknown>;
  approvalId?: string;
}) {
  const prompt = firstNonEmptyString(payload.prompt);
  const flowName = firstNonEmptyString(payload.flowName);
  const nodeId = firstNonEmptyString(payload.nodeId);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.approvals.prDiff(approvalId ?? ""),
    queryFn: () => approvalsApi.getPrDiff(approvalId as string),
    enabled: !!approvalId,
    staleTime: 15_000,
  });

  return (
    <div className="mt-3 space-y-3 text-sm">
      {(flowName || nodeId) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {flowName && <span className="font-mono">{flowName}</span>}
          {nodeId && <span>gate &lsquo;{nodeId}&rsquo;</span>}
        </div>
      )}
      {prompt && <p className="leading-6 text-foreground/90">{prompt}</p>}

      {!approvalId ? null : isLoading ? (
        <p className="text-xs text-muted-foreground">Loading pull request…</p>
      ) : !data ? (
        <p className="text-xs text-muted-foreground">Couldn&rsquo;t load the pull request.</p>
      ) : data.available === false ? (
        <p className="text-xs text-muted-foreground">No linked pull request found for this gate.</p>
      ) : data.degraded ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          Couldn&rsquo;t load {data.repo}#{data.headBranch}: {data.error}
        </div>
      ) : (
        <div className="space-y-2 rounded-md border border-border/60 bg-background/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <a
              href={data.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate font-medium text-foreground hover:underline"
            >
              {data.title || `${data.repo}#${data.headBranch}`}
            </a>
            <span className="shrink-0 text-xs text-muted-foreground">
              <span className="text-green-600 dark:text-green-400">+{data.totals.additions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">-{data.totals.deletions}</span>{" "}
              · {data.totals.changedFiles} file{data.totals.changedFiles === 1 ? "" : "s"}
            </span>
          </div>
          {data.files.length > 0 && (
            <ul className="space-y-1 border-t border-border/60 pt-2">
              {data.files.map((file) => (
                <PullRequestFileRow key={file.path} file={file} />
              ))}
            </ul>
          )}
          {data.files_truncated && (
            <p className="text-(length:--text-micro) text-muted-foreground">
              Showing the first {data.files.length} changed files — more were truncated.
            </p>
          )}
          {data.acceptanceEvaluation && (
            <p className="border-t border-border/60 pt-2 text-(length:--text-micro) text-muted-foreground">
              {data.acceptanceEvaluation}
            </p>
          )}
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
