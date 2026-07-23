// Ops section — APEX + CI run status (apex-tower migration — Task 2 §3b).
//
// The infra-run side of Observe, surfaced as an "Ops" tab on the Costs page
// (rather than a whole new page, per the migration doc). Two cards: recent APEX
// workflow instances and recent GitHub Actions runs. Distinct from the Costs
// tabs, which are LLM token/spend. Cloud-auth-gated, so it carries the same
// session-expiry banner as the cloud settings surface.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, GitBranch, RefreshCw } from "lucide-react";
import { apexObserveApi } from "../api/apex-observe";
import { GcloudAuthBanner } from "./GcloudAuthBanner";
import { StatusBadge } from "./status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function statusVariant(s: string, conclusion?: string | null) {
  const v = (conclusion || s).toLowerCase();
  if (["success", "completed", "passed"].includes(v)) return "success" as const;
  if (["failure", "failed", "error", "cancelled"].includes(v)) return "danger" as const;
  if (["in_progress", "queued", "running", "pending"].includes(v)) return "info" as const;
  return "default" as const;
}

function CardShell({
  icon,
  title,
  onReload,
  loading,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  onReload: () => void;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </CardTitle>
        <button
          type="button"
          onClick={onReload}
          className="text-muted-foreground transition hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Empty({ note }: { note?: string }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{note ?? "No data yet."}</p>;
}

function formatDuration(ms: number | null): string | null {
  if (ms == null) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatTokens(n: number | null): string | null {
  if (n == null) return null;
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function AgentRunsCard() {
  const query = useQuery({
    queryKey: ["apex-observe", "agent-runs"],
    queryFn: () => apexObserveApi.agentRuns(),
    refetchInterval: 15_000,
  });
  const runs = query.data?.runs ?? [];
  return (
    <CardShell
      icon={<Bot className="h-4 w-4" />}
      title="Agent runs"
      onReload={() => void query.refetch()}
      loading={query.isFetching}
    >
      {runs.length === 0 ? (
        <Empty note={query.data?.note ?? "No agent runs yet — assign an issue to an agent and wake it."} />
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r) => {
            const inTok = formatTokens(r.usage?.inputTokens ?? null);
            const outTok = formatTokens(r.usage?.outputTokens ?? null);
            const dur = formatDuration(r.durationMs);
            return (
              <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1">
                  <span className="truncate font-medium" title={r.issueTitle ?? r.agentName}>
                    {r.issueTitle ?? "(no issue)"}
                  </span>
                  <span className="ml-1.5 text-muted-foreground">· {r.agentName}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                  {dur && <span className="tabular-nums">{dur}</span>}
                  {(inTok || outTok) && (
                    <span className="tabular-nums" title="input → output tokens">
                      {inTok ?? "—"}→{outTok ?? "—"}
                    </span>
                  )}
                  {r.usage?.costUsd != null && (
                    <span className="tabular-nums">${r.usage.costUsd.toFixed(3)}</span>
                  )}
                  <StatusBadge variant={statusVariant(r.status)}>{r.status}</StatusBadge>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {query.data?.source && (
        <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
          source: {query.data.source}
        </p>
      )}
    </CardShell>
  );
}

function ApexRunsCard() {
  const query = useQuery({
    queryKey: ["apex-observe", "apex-runs"],
    queryFn: () => apexObserveApi.apexRuns(),
  });
  const runs = query.data?.runs ?? [];
  return (
    <CardShell
      icon={<Activity className="h-4 w-4" />}
      title="Recent APEX runs"
      onReload={() => void query.refetch()}
      loading={query.isFetching}
    >
      {runs.length === 0 ? (
        <Empty note={query.data?.note ?? "No APEX instances found."} />
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r) => (
            <li key={r.name} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-medium" title={r.name}>
                {r.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Badge variant="default">{r.mode}</Badge>
                <StatusBadge variant={statusVariant(r.status)}>{r.status}</StatusBadge>
              </span>
            </li>
          ))}
        </ul>
      )}
      {query.data?.source && (
        <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
          source: {query.data.source}
        </p>
      )}
    </CardShell>
  );
}

function CiRunsCard() {
  const [repo, setRepo] = useState("");
  const query = useQuery({
    queryKey: ["apex-observe", "ci-runs", repo],
    queryFn: () => apexObserveApi.ciRuns(repo),
    enabled: repo.length > 0,
  });
  const runs = query.data?.runs ?? [];
  return (
    <CardShell
      icon={<GitBranch className="h-4 w-4" />}
      title="Recent CI runs"
      onReload={() => void query.refetch()}
      loading={query.isFetching}
    >
      <input
        value={repo}
        onChange={(e) => setRepo(e.target.value.trim())}
        placeholder="owner/name"
        className="mb-2 w-full rounded-md border border-border bg-transparent px-2.5 py-1 text-xs outline-none"
      />
      {repo.length === 0 ? (
        <Empty note="Enter a repository (owner/name) to list its GitHub Actions runs." />
      ) : runs.length === 0 ? (
        <Empty note={query.data?.note ?? "No CI runs found."} />
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r) => (
            <li key={r.databaseId} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate" title={r.displayTitle}>
                {r.workflowName}
              </span>
              <StatusBadge variant={statusVariant(r.status, r.conclusion)}>
                {r.conclusion || r.status}
              </StatusBadge>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

export function OpsSection() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Run status — embedded agents working issues, plus APEX workflow instances and CI.
        Agent runs come from the cockpit; APEX/CI read your local <code>apex</code> /{" "}
        <code>gh</code> auth.
      </p>
      <GcloudAuthBanner />
      <AgentRunsCard />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ApexRunsCard />
        <CiRunsCard />
      </div>
    </div>
  );
}
