// Run detail — the provenance thread for one agent run: header (agent, ticket,
// status, cost), the OTel-backed span tree (from apex-eval's flat trace, nested
// here by parentSpanId → spanId), and the eval verdicts recorded against it.
// Fed by GET /observe/run-detail/:runId (server/src/routes/apex-observe.ts),
// which is already failure-isolated per source — a down apex-eval degrades the
// trace/evals to empty, it never breaks the run header.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@/lib/router";
import { ArrowLeft, ChevronDown, ChevronRight, ClipboardCheck, GitCommitHorizontal } from "lucide-react";
import { observeApi } from "@/api/observe";
import { Link } from "@/lib/router";
import { StatusBadge } from "@/apex/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDuration, formatTokens, relTime, runStatusVariant, ScoreBar, VerdictPill } from "@/lib/observe-format";
import {
  buildSpanTree,
  isErrorSpan,
  type RunDetail as RunDetailRecord,
  type SpanTreeNode,
  type TraceSpan,
} from "@paperclipai/shared";

function spanKey(node: TraceSpan, path: string): string {
  return node.spanId ?? path;
}

function SpanRow({
  node,
  path,
  collapsed,
  toggle,
}: {
  node: SpanTreeNode;
  path: string;
  collapsed: Set<string>;
  toggle: (key: string) => void;
}) {
  const key = spanKey(node, path);
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(key);
  const isError = isErrorSpan(node);

  return (
    <>
      <div
        className={`flex items-center gap-2 rounded-md px-1.5 py-1 text-xs ${
          isError ? "bg-rose-500/10" : ""
        }`}
        style={{ paddingLeft: `${node.depth * 16 + 6}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => toggle(key)}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={isCollapsed ? "Expand span" : "Collapse span"}
          >
            {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span
          className={`shrink-0 rounded border px-1 py-0 text-[10px] uppercase tracking-wide ${
            isError
              ? "border-rose-500/40 text-rose-600 dark:text-rose-400"
              : "border-border text-muted-foreground"
          }`}
        >
          {node.kind}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium" title={node.name}>
          {node.name}
        </span>
        {isError && (
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-rose-600 dark:text-rose-400">
            error
          </span>
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground">{relTime(node.startedAt)}</span>
        <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">
          {formatDuration(node.durationMs)}
        </span>
      </div>
      {hasChildren && !isCollapsed && (
        <div>
          {node.children.map((child, i) => (
            <SpanRow key={spanKey(child, `${path}.${i}`)} node={child} path={`${path}.${i}`} collapsed={collapsed} toggle={toggle} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * Pure, query-free render of the detail body — split out from `RunDetail` so
 * every loading/error/empty/populated branch is directly testable with plain
 * props instead of having to coax react-query's cache into each state.
 */
export function RunDetailBody({
  isLoading,
  isError,
  data,
}: {
  isLoading: boolean;
  isError: boolean;
  data: RunDetailRecord | undefined;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading run…</div>;
  }

  if (isError || !data) {
    return (
      <div className="space-y-4 p-4">
        <BackLink />
        <p className="text-sm text-rose-600 dark:text-rose-400">
          Run not found, or apex-eval and every other observe source failed to answer for it.
        </p>
      </div>
    );
  }

  const { run, spans, evals } = data;
  const tree = buildSpanTree(spans);

  return (
    <div className="space-y-4 p-4">
      <BackLink />

      {/* Header */}
      <Card>
        <CardContent className="space-y-2 pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-mono text-sm font-semibold" title={run.runId}>
              {run.runId}
            </h1>
            <StatusBadge variant={runStatusVariant(run.status)}>{run.status}</StatusBadge>
            {run.permissionMode === "governed" ? (
              <StatusBadge variant="info" title="This run was commissioned by the flow coordinator with a governed permission profile — dangerously-skip-permissions off, a bounded --allowedTools grant instead.">
                governed{run.permissionProfile ? ` · ${run.permissionProfile}` : ""}
              </StatusBadge>
            ) : (
              <StatusBadge variant="warning" title="This run used the fork's default dangerously-skip-permissions bypass (interactive runs, or any run the flow coordinator didn't commission).">
                bypass
              </StatusBadge>
            )}
            {run.agentName && <span className="text-sm text-muted-foreground">{run.agentName}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
            {run.issueId && (
              <span className="flex items-center gap-1">
                <GitCommitHorizontal className="h-3 w-3" />
                ticket {run.issueId.slice(0, 8)}
              </span>
            )}
            <span>started {relTime(run.startedAt)}</span>
            <span>duration {formatDuration(run.durationMs)}</span>
            {run.stopReason && <span>stop reason: {run.stopReason}</span>}
            {run.usage && (
              <>
                <span title="in → out tokens">
                  {formatTokens(run.usage.inputTokens)}→{formatTokens(run.usage.outputTokens)} tokens
                </span>
                {run.usage.costUsd != null && <span>${run.usage.costUsd.toFixed(4)}</span>}
                {run.usage.model && <span className="font-mono">{run.usage.model}</span>}
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Span tree */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-base">Trace</CardTitle>
        </CardHeader>
        <CardContent>
          {tree.length === 0 ? (
            <p className="text-xs text-muted-foreground">No trace recorded for this run.</p>
          ) : (
            <div className="space-y-0.5">
              {tree.map((node, i) => (
                <SpanRow key={spanKey(node, String(i))} node={node} path={String(i)} collapsed={collapsed} toggle={toggle} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Evals */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Evals</CardTitle>
        </CardHeader>
        <CardContent>
          {evals.length === 0 ? (
            <p className="text-xs text-muted-foreground">No evals recorded for this run.</p>
          ) : (
            <ul className="space-y-1.5">
              {evals.map((e, i) => (
                <li key={`${e.validator ?? "evaluator"}-${e.occurredAt ?? i}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <VerdictPill verdict={e.verdict} />
                    <span className="min-w-0 truncate" title={e.validator ?? e.scenario ?? undefined}>
                      <span className="font-medium">{e.validator ?? "evaluator"}</span>
                      {e.scenario && <span className="text-muted-foreground"> · {e.scenario}</span>}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
                    <ScoreBar score={e.score} verdict={e.verdict} />
                    {e.reason && (
                      <span className="max-w-64 truncate" title={e.reason}>
                        {e.reason}
                      </span>
                    )}
                    <span className="tabular-nums">{relTime(e.occurredAt)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function RunDetail() {
  const { runId } = useParams<{ runId: string }>();

  const detail = useQuery({
    queryKey: ["observe", "run-detail", runId],
    queryFn: () => observeApi.runDetail(runId as string),
    enabled: !!runId,
    retry: false,
  });

  if (!runId) {
    return <div className="p-6 text-sm text-muted-foreground">No run selected.</div>;
  }

  return <RunDetailBody isLoading={detail.isLoading} isError={detail.isError} data={detail.data} />;
}

function BackLink() {
  return (
    <Link to="/observe" className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3 w-3" />
      Back to Observe
    </Link>
  );
}
