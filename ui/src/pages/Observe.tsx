// Observe — the per-company observability dashboard (real observability, not
// resource visibility): agent runs, fleet health, and regressions, correlated by
// the semantic contract. Deterministic UI (this is the moat surface — hand-built,
// not generated); the same data is available to agents via the observe MCP tools.

import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, ClipboardCheck, TrendingDown } from "lucide-react";
import { observeApi } from "@/api/observe";
import { useCompany } from "@/context/CompanyContext";
import { StatusBadge, type StatusVariant } from "@/apex/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EvalRecord, EvalVerdict, FleetHealth } from "@paperclipai/shared";

function runStatusVariant(s: string) {
  const v = s.toLowerCase();
  if (["succeeded", "completed", "passed", "success", "done"].includes(v)) return "success" as const;
  if (["failed", "error", "cancelled", "canceled"].includes(v)) return "danger" as const;
  if (["running", "queued", "in_progress", "pending"].includes(v)) return "info" as const;
  return "default" as const;
}

const HEALTH_DOT: Record<FleetHealth, string> = {
  ok: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-rose-500",
  dark: "bg-slate-400",
  unknown: "bg-slate-300",
};

function HealthDot({ health }: { health: FleetHealth }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs capitalize">
      <span className={`h-2 w-2 rounded-full ${HEALTH_DOT[health]}`} />
      {health}
    </span>
  );
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}
function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}
function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// warn (amber) has no StatusBadge semantic variant (only success/danger/info) —
// same amber convention as the regressions callout above; kept local rather
// than added to StatusBadge since "warn" is eval-specific vocabulary.
const VERDICT_BADGE: Record<EvalVerdict, StatusVariant | "warn"> = {
  pass: "success",
  warn: "warn",
  fail: "danger",
};
const VERDICT_BAR: Record<EvalVerdict, string> = {
  pass: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-rose-500",
};
const VERDICT_LABEL: Record<EvalVerdict, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
};

function VerdictPill({ verdict }: { verdict: EvalVerdict | null }) {
  if (verdict == null) return <StatusBadge variant="default">unknown</StatusBadge>;
  if (verdict === "warn") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/30 bg-amber-500/10 text-amber-500 dark:text-amber-400"
      >
        {VERDICT_LABEL.warn}
      </Badge>
    );
  }
  return <StatusBadge variant={VERDICT_BADGE[verdict] as StatusVariant}>{VERDICT_LABEL[verdict]}</StatusBadge>;
}

function ScoreBar({ score, verdict }: { score: number | null; verdict: EvalVerdict | null }) {
  if (score == null) return <span className="text-xs text-muted-foreground">—</span>;
  const barColor = verdict ? VERDICT_BAR[verdict] : "bg-slate-400";
  return (
    <span className="flex items-center gap-1.5" title={`score ${score.toFixed(2)}`}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <span
          className={`block h-full rounded-full ${barColor}`}
          style={{ width: `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%` }}
        />
      </span>
      <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
        {Math.round(score * 100)}%
      </span>
    </span>
  );
}

function evalVerdictCounts(evals: EvalRecord[]) {
  return evals.reduce(
    (acc, e) => {
      if (e.verdict) acc[e.verdict] += 1;
      return acc;
    },
    { pass: 0, warn: 0, fail: 0 },
  );
}

function StatCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="px-4 py-3">
      <div className={`font-mono text-xl tabular-nums ${tone ?? ""}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

export function Observe() {
  const { selectedCompanyId } = useCompany();
  const scope = selectedCompanyId ? { companyId: selectedCompanyId } : undefined;
  const enabled = !!selectedCompanyId;

  const health = useQuery({
    queryKey: ["observe", "health", selectedCompanyId],
    queryFn: () => observeApi.health(scope),
    enabled,
    refetchInterval: 15_000,
  });
  const fleet = useQuery({
    queryKey: ["observe", "fleet", selectedCompanyId],
    queryFn: () => observeApi.fleet(scope),
    enabled,
    refetchInterval: 15_000,
  });
  const runs = useQuery({
    queryKey: ["observe", "runs", selectedCompanyId],
    queryFn: () => observeApi.runs({ ...scope, limit: 15 }),
    enabled,
    refetchInterval: 15_000,
  });
  const regressions = useQuery({
    queryKey: ["observe", "regressions", selectedCompanyId],
    queryFn: () => observeApi.regressions(scope),
    enabled,
  });
  const evals = useQuery({
    queryKey: ["observe", "evals", selectedCompanyId],
    queryFn: () => observeApi.evals({ ...scope, limit: 20 }),
    enabled,
    refetchInterval: 15_000,
  });

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Select a company to see its observability.
      </div>
    );
  }

  const h = health.data;
  const fleetRows = fleet.data ?? [];
  const runRows = runs.data ?? [];
  const regs = regressions.data ?? [];
  const evalRows = evals.data ?? [];
  const evalCounts = evalVerdictCounts(evalRows);

  return (
    <div className="space-y-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">Observe</h1>
        <p className="text-sm text-muted-foreground">
          Real observability for this company — agent runs, fleet health, and regressions.
        </p>
      </div>

      {/* Health summary strip */}
      <Card>
        <div className="grid grid-cols-2 divide-x divide-border sm:grid-cols-6">
          <StatCell label="runs · 24h" value={h ? String(h.total) : "—"} />
          <StatCell
            label="success"
            value={h ? pct(h.successRate) : "—"}
            tone="text-emerald-600 dark:text-emerald-400"
          />
          <StatCell label="running" value={h ? String(h.running) : "—"} />
          <StatCell label="failed" value={h ? String(h.failed) : "—"} tone={h && h.failed > 0 ? "text-rose-600 dark:text-rose-400" : ""} />
          <StatCell label="avg dur" value={formatDuration(h?.avgDurationMs ?? null)} />
          <StatCell label="cost · 24h" value={h ? `$${h.totalCostUsd.toFixed(2)}` : "—"} />
        </div>
      </Card>

      {/* Regressions callout */}
      {regs.length > 0 && (
        <Card className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/10">
          <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
            <TrendingDown className="h-4 w-4 text-amber-600" />
            <CardTitle className="text-sm">Regressions vs. prior window</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            {regs.map((r, i) => (
              <span key={i} className="tabular-nums">
                <span className="font-medium">{r.displayName}</span>{" "}
                <span className="text-amber-700 dark:text-amber-400">
                  {r.deltaPct > 0 ? "+" : ""}
                  {r.deltaPct}%
                </span>{" "}
                <span className="text-muted-foreground">({r.window})</span>
              </span>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Fleet */}
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Bot className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Fleet</CardTitle>
          </CardHeader>
          <CardContent>
            {fleetRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No agents have run for this company yet.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {fleetRows.map((f) => (
                  <li key={f.agentId ?? f.displayName} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate font-medium" title={f.displayName}>
                      {f.displayName}
                    </span>
                    <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
                      <span className="tabular-nums" title="runs · 24h">{f.runs24h}</span>
                      <span className="tabular-nums" title="success rate">{pct(f.successRate)}</span>
                      <span className="tabular-nums">{relTime(f.lastRunAt)}</span>
                      <HealthDot health={f.health} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Recent runs */}
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Recent runs</CardTitle>
          </CardHeader>
          <CardContent>
            {runRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">No runs yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {runRows.map((r) => (
                  <li key={r.runId} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate" title={r.agentName ?? r.runId}>
                      {r.agentName ?? "agent"}
                      {r.issueId && <span className="ml-1.5 text-muted-foreground">· {r.issueId.slice(0, 8)}</span>}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                      <span className="tabular-nums">{formatDuration(r.durationMs)}</span>
                      <span className="tabular-nums" title="in → out tokens">
                        {formatTokens(r.usage?.inputTokens)}→{formatTokens(r.usage?.outputTokens)}
                      </span>
                      {r.usage?.costUsd != null && (
                        <span className="tabular-nums">${r.usage.costUsd.toFixed(3)}</span>
                      )}
                      <StatusBadge variant={runStatusVariant(r.status)}>{r.status}</StatusBadge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Evals */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <ClipboardCheck className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Evals</CardTitle>
        </CardHeader>
        <CardContent>
          {evals.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading evals…</p>
          ) : evals.isError ? (
            <p className="text-xs text-rose-600 dark:text-rose-400">
              Failed to load evals.
            </p>
          ) : evalRows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No evals yet.</p>
          ) : (
            <div className="space-y-3">
              {/* Summary strip */}
              <div className="flex items-center gap-4 text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span className="tabular-nums font-medium">{evalCounts.pass}</span>
                  <span className="text-muted-foreground">pass</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-amber-500" />
                  <span className="tabular-nums font-medium">{evalCounts.warn}</span>
                  <span className="text-muted-foreground">warn</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  <span className="tabular-nums font-medium">{evalCounts.fail}</span>
                  <span className="text-muted-foreground">fail</span>
                </span>
              </div>

              <ul className="space-y-1.5">
                {evalRows.map((e, i) => (
                  <li
                    key={`${e.runId ?? "no-run"}-${e.occurredAt ?? i}`}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <VerdictPill verdict={e.verdict} />
                      <span className="min-w-0 truncate" title={e.validator ?? e.scenario ?? undefined}>
                        <span className="font-medium">{e.validator ?? "evaluator"}</span>
                        {e.scenario && (
                          <span className="text-muted-foreground"> · {e.scenario}</span>
                        )}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-3 text-muted-foreground">
                      <ScoreBar score={e.score} verdict={e.verdict} />
                      {e.runId && (
                        <span className="font-mono tabular-nums" title={e.runId}>
                          {e.runId.slice(0, 8)}
                        </span>
                      )}
                      <span className="tabular-nums">{relTime(e.occurredAt)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
