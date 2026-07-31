// Observe — the per-company observability dashboard (real observability, not
// resource visibility): agent runs, fleet health, and regressions, correlated by
// the semantic contract. Deterministic UI (this is the moat surface — hand-built,
// not generated); the same data is available to agents via the observe MCP tools.

import { useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Bot, ChevronDown, ChevronRight, ClipboardCheck, Network, Server, TrendingDown } from "lucide-react";
import { observeApi } from "@/api/observe";
import { useCompany } from "@/context/CompanyContext";
import { StatusBadge, type StatusVariant } from "@/apex/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  AttributionConflict,
  EvalRecord,
  EvalVerdict,
  FleetEntry,
  FleetHealth,
  InventoryResource,
  ProjectInventory,
} from "@paperclipai/shared";

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
// Provenance-at-birth (spec: provenance-at-birth) — flattens an inventory's
// resourcesByType map into the resources whose attribution classified as
// "exception" (unexplained: no apex_managed label, not found in the state
// registry either). Only meaningful when attributionSummary is present.
function exceptionResources(inv: ProjectInventory): Array<{ assetType: string; resource: InventoryResource }> {
  const out: Array<{ assetType: string; resource: InventoryResource }> = [];
  for (const [assetType, resources] of Object.entries(inv.resourcesByType)) {
    for (const resource of resources) {
      if (resource.attribution?.status === "exception") out.push({ assetType, resource });
    }
  }
  return out;
}

// Provenance-at-birth overlay (spec: resource-attribution-mapping) — the
// non-zero counts segments for the GCP Inventory card's summary line, in
// display order. Exceptions are handled separately by the caller (always
// shown, even at zero, colored amber when > 0) — everything else here is
// omitted when its count is zero so a project with no db attributions at all
// still reads cleanly as "N resources · N types · N exceptions".
function attributionCountsSegments(s: NonNullable<ProjectInventory["attributionSummary"]>): string[] {
  const segs: string[] = [];
  if (s.label > 0) segs.push(`${s.label} by label`);
  if (s.registry > 0) segs.push(`${s.registry} by registry`);
  if ((s.inherited ?? 0) > 0) segs.push(`${s.inherited} inherited`);
  if ((s.system ?? 0) > 0) segs.push(`${s.system} system`);
  if ((s.mapped ?? 0) > 0) segs.push(`${s.mapped} mapped`);
  if ((s.manual ?? 0) > 0) segs.push(`${s.manual} manual`);
  return segs;
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

// A product agent IS a Cloud Run service — fleet entries surfaced from the
// GCP resource plane (server/src/observe/cloud-trace-store.ts `fleet()`),
// distinguished from coding-plane agents by source + agentKind.
function isProductService(f: FleetEntry): boolean {
  return f.source === "gcp" || f.agentKind === "product";
}

// status === "True" is the Cloud Run resource-condition convention (Ready,
// ContainerHealthy, etc.) — anything else (False/Unknown) is a warn state.
function conditionVariant(status: string | null): StatusVariant | "warn" {
  return status === "True" ? "success" : "warn";
}

// Cloud Logging severities → the same badge semantics used elsewhere on this
// page (ERROR=danger, WARN/WARNING=amber warn, everything else=neutral info).
function logSeverityVariant(severity: string | null): StatusVariant | "warn" {
  const s = (severity ?? "").toUpperCase();
  if (s === "ERROR" || s === "CRITICAL" || s === "ALERT" || s === "EMERGENCY") return "danger";
  if (s === "WARN" || s === "WARNING") return "warn";
  return "default";
}

function WarnableBadge({ variant, children }: { variant: StatusVariant | "warn"; children: ReactNode }) {
  if (variant === "warn") {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/30 bg-amber-500/10 text-amber-500 dark:text-amber-400"
      >
        {children}
      </Badge>
    );
  }
  return <StatusBadge variant={variant}>{children}</StatusBadge>;
}

function StatCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="px-4 py-3">
      <div className={`font-mono text-xl tabular-nums ${tone ?? ""}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

/**
 * Groups Observe's cards along three concerns: raw signal ("Logs & Traces" —
 * what exists and what happened), objective telemetry ("Metrics & Alerts" —
 * success rate/duration/cost SLIs and threshold/trend-breach alerts), and
 * judgment-requiring quality assessment ("Evals" — industry-standard term,
 * kept as its own section rather than folded into Metrics). Gateway's own
 * governance data (registry, audit ledger) stays out of Observe entirely; only
 * its metrics/stats (operational health, not governance) land in Metrics & Alerts.
 */
function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {children}
      </h2>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export function Observe() {
  const { selectedCompanyId } = useCompany();
  const scope = selectedCompanyId ? { companyId: selectedCompanyId } : undefined;
  const enabled = !!selectedCompanyId;
  const queryClient = useQueryClient();

  // Selected product agent (Cloud Run service) for the GCP Resource detail
  // pane below the Fleet panel. Cleared implicitly on company switch since
  // the fleet query key changes and the selection no longer resolves to a row.
  const [selectedService, setSelectedService] = useState<string | null>(null);

  // GCP Inventory card — which projects have their exception-attribution list
  // expanded. Only relevant when the project's inventory carries
  // attribution_summary (older apex-core builds never populate it, so the
  // card has nothing to expand there).
  const [expandedExceptions, setExpandedExceptions] = useState<Set<string>>(new Set());
  function toggleExceptions(projectId: string) {
    setExpandedExceptions((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  // Same expand/collapse pattern as the exception list, keyed by project — for
  // the attribution-conflict list (spec: resource-attribution-mapping).
  const [expandedConflicts, setExpandedConflicts] = useState<Set<string>>(new Set());
  function toggleConflicts(projectId: string) {
    setExpandedConflicts((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  const keepMapping = useMutation({
    mutationFn: (conflict: AttributionConflict) =>
      observeApi.attributionManual({
        companyId: selectedCompanyId as string,
        projectId: conflict.projectId,
        resourceUri: conflict.resourceUri,
        assetType: conflict.assetType,
        workflow: conflict.mapping.workflow,
        repo: conflict.mapping.repo,
        env: conflict.mapping.env,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["observe", "gcp-inventory", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: ["observe", "attribution-conflicts", selectedCompanyId] });
    },
  });

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
  const gcpResource = useQuery({
    queryKey: ["observe", "gcp-resource", selectedCompanyId, selectedService],
    queryFn: () => observeApi.gcpResource({ ...scope, service: selectedService as string }),
    enabled: enabled && !!selectedService,
    refetchInterval: 15_000,
  });
  const gcpInventory = useQuery({
    queryKey: ["observe", "gcp-inventory", selectedCompanyId],
    queryFn: () => observeApi.gcpInventory(scope),
    enabled,
    refetchInterval: 30_000,
  });
  const gcpServices = useQuery({
    queryKey: ["observe", "gcp-services", selectedCompanyId],
    queryFn: () => observeApi.gcpServices(scope),
    enabled,
    refetchInterval: 30_000,
  });
  const attributionConflicts = useQuery({
    queryKey: ["observe", "attribution-conflicts", selectedCompanyId],
    queryFn: () => observeApi.attributionConflicts({ companyId: selectedCompanyId as string }),
    enabled,
    refetchInterval: 30_000,
  });
  // Gateway tool-call metrics — a single shared apex-gateway instance, not
  // per-company, so no scope/enabled gate needed.
  const gatewayMetrics = useQuery({
    queryKey: ["observe", "gateway-metrics"],
    queryFn: observeApi.gatewayMetrics,
    refetchInterval: 20_000,
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

      <SectionHeader>Metrics &amp; Alerts</SectionHeader>

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

      {/* Gateway metrics — apex-gateway's tool/server/agent invocation
          throughput, failure rate, avg response time. Operational health, not
          governance — see the Gateway page for registry/audit instead. */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Network className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Gateway</CardTitle>
        </CardHeader>
        <CardContent>
          {gatewayMetrics.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading gateway metrics…</p>
          ) : !gatewayMetrics.data?.reachable ? (
            <p className="text-xs text-muted-foreground">
              {gatewayMetrics.data?.error ?? "Gateway unreachable."}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {(
                [
                  ["tools", gatewayMetrics.data.tools],
                  ["servers", gatewayMetrics.data.servers],
                  ["a2a agents", gatewayMetrics.data.a2aAgents],
                ] as const
              ).map(([label, m]) =>
                m ? (
                  <div key={label} className="space-y-0.5 text-xs">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {label}
                    </div>
                    <div className="flex items-baseline gap-3">
                      <span className="tabular-nums" title="total executions">
                        {m.totalExecutions}
                      </span>
                      <span
                        className={`tabular-nums ${
                          m.failureRate != null && m.failureRate > 0
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-muted-foreground"
                        }`}
                        title="failure rate"
                      >
                        {m.failureRate != null ? `${Math.round(m.failureRate * 100)}% fail` : "—"}
                      </span>
                      <span className="tabular-nums text-muted-foreground" title="avg response time">
                        {m.avgResponseTime != null ? `${Math.round(m.avgResponseTime * 1000)}ms` : "—"}
                      </span>
                    </div>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <SectionHeader>Evals</SectionHeader>

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

      <SectionHeader>Logs &amp; Traces</SectionHeader>

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
                {fleetRows.map((f) => {
                  const selectable = isProductService(f);
                  const selected = selectable && selectedService === f.displayName;
                  return (
                    <li
                      key={f.agentId ?? f.displayName}
                      role={selectable ? "button" : undefined}
                      tabIndex={selectable ? 0 : undefined}
                      onClick={selectable ? () => setSelectedService(f.displayName) : undefined}
                      onKeyDown={
                        selectable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelectedService(f.displayName);
                              }
                            }
                          : undefined
                      }
                      className={`flex items-center justify-between gap-2 rounded-md px-1.5 py-0.5 text-xs ${
                        selectable
                          ? `cursor-pointer hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                              selected ? "bg-accent text-accent-foreground" : ""
                            }`
                          : ""
                      }`}
                    >
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
                  );
                })}
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

      {/* GCP Inventory — everything deployed in this company's bound GCP
          project(s), not just running product agents. Distinct from Fleet
          above (agents that have actually run) and from the per-service detail
          below (one Cloud Run service's health/logs) — this is "what exists"
          across all resource types, via APEX's gcp_inventory server. */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Server className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">GCP Inventory</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {gcpInventory.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading inventory…</p>
          ) : gcpInventory.isError ? (
            <p className="text-xs text-rose-600 dark:text-rose-400">Failed to load GCP inventory.</p>
          ) : (gcpInventory.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No GCP projects bound to this company yet — bind one in Company Settings → Cloud.
            </p>
          ) : (
            (gcpInventory.data ?? []).map((inv) => {
              const exceptions = inv.attributionSummary ? exceptionResources(inv) : [];
              const isExpanded = expandedExceptions.has(inv.projectId);
              const conflictsForProject = (attributionConflicts.data ?? []).filter(
                (c) => c.projectId === inv.projectId,
              );
              const isConflictsExpanded = expandedConflicts.has(inv.projectId);
              return (
                <div key={inv.projectId} className="space-y-1.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-medium">{inv.projectId}</span>
                    {inv.error ? (
                      <span className="text-rose-600 dark:text-rose-400">— {inv.error}</span>
                    ) : (
                      <span className="text-muted-foreground">
                        {inv.totalResources ?? "—"} resources · {inv.resourceTypes ?? "—"} types
                        {inv.attributionSummary && (
                          <>
                            {" · "}
                            {(() => {
                              const segs = attributionCountsSegments(inv.attributionSummary);
                              return segs.length > 0 ? `${segs.join(" · ")} · ` : "";
                            })()}
                            <span
                              className={
                                inv.attributionSummary.exception > 0
                                  ? "text-amber-600 dark:text-amber-400"
                                  : undefined
                              }
                            >
                              {inv.attributionSummary.exception} exceptions
                            </span>
                          </>
                        )}
                      </span>
                    )}
                    {conflictsForProject.length > 0 && (
                      <Badge
                        variant="outline"
                        className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400"
                      >
                        {conflictsForProject.length} conflict{conflictsForProject.length === 1 ? "" : "s"}
                      </Badge>
                    )}
                  </div>
                  {!inv.error && Object.keys(inv.resourcesByType).length > 0 && (
                    <ul className="grid grid-cols-1 gap-x-4 gap-y-1 pl-1 sm:grid-cols-2 lg:grid-cols-3">
                      {Object.entries(inv.resourcesByType).map(([assetType, resources]) => (
                        <li
                          key={assetType}
                          className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                          title={assetType}
                        >
                          <span className="min-w-0 flex-1 truncate">{assetType.split("/").pop()}</span>
                          <span className="shrink-0 tabular-nums">{resources.length}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!inv.error && inv.attributionSummary && exceptions.length > 0 && (
                    <div className="pl-1">
                      <button
                        type="button"
                        onClick={() => toggleExceptions(inv.projectId)}
                        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        {exceptions.length} unexplained resource{exceptions.length === 1 ? "" : "s"}
                      </button>
                      {isExpanded && (
                        <ul className="mt-1 space-y-1 border-l border-border pl-3">
                          {exceptions.map(({ assetType, resource }, i) => (
                            <li
                              key={`${assetType}-${resource.name ?? i}`}
                              className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                            >
                              <span className="min-w-0 flex-1 truncate" title={resource.name ?? undefined}>
                                {resource.displayName ?? resource.name ?? "—"}
                              </span>
                              <span className="shrink-0 truncate text-[10px] uppercase tracking-wide">
                                {assetType.split("/").pop()}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {!inv.error && conflictsForProject.length > 0 && (
                    <div className="pl-1">
                      <button
                        type="button"
                        onClick={() => toggleConflicts(inv.projectId)}
                        className="flex items-center gap-1 text-xs text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300"
                      >
                        {isConflictsExpanded ? (
                          <ChevronDown className="h-3 w-3 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 shrink-0" />
                        )}
                        {conflictsForProject.length} label/mapping conflict{conflictsForProject.length === 1 ? "" : "s"}
                      </button>
                      {isConflictsExpanded && (
                        <ul className="mt-1 space-y-1.5 border-l border-border pl-3">
                          {conflictsForProject.map((c) => (
                            <li key={c.resourceUri} className="space-y-0.5 text-xs">
                              <div className="flex min-w-0 items-center justify-between gap-2">
                                <span
                                  className="min-w-0 flex-1 truncate text-muted-foreground"
                                  title={c.resourceUri}
                                >
                                  {c.displayName ?? c.resourceUri}
                                </span>
                                <button
                                  type="button"
                                  disabled={keepMapping.isPending}
                                  onClick={() => keepMapping.mutate(c)}
                                  className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                                >
                                  Keep mapping
                                </button>
                              </div>
                              <div className="pl-0 text-[11px] text-muted-foreground">
                                label says {c.label.workflow ?? "—"}/{c.label.repo ?? "—"}/{c.label.env ?? "—"} · mapping
                                says {c.mapping.workflow ?? "—"}/{c.mapping.repo ?? "—"}/{c.mapping.env ?? "—"}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {(gcpServices.data ?? []).length > 0 && (
            <div className="space-y-1.5 border-t border-border pt-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Services</div>
              {(gcpServices.data ?? []).map((svc) => (
                <div key={svc.projectId} className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="font-mono">{svc.projectId}</span>
                  {svc.error ? (
                    <span className="text-rose-600 dark:text-rose-400">{svc.error}</span>
                  ) : (
                    <>
                      <span className="text-muted-foreground">cloud run: {svc.cloudRun?.length ?? 0}</span>
                      <span className="text-muted-foreground">buckets: {svc.buckets?.length ?? 0}</span>
                      <span className="text-muted-foreground">secrets: {svc.secrets?.length ?? 0}</span>
                      <span className="text-muted-foreground">APIs enabled: {svc.enabledApis?.length ?? 0}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* GCP Resource detail — shown when a product agent (Cloud Run service) is
          selected in Fleet. Unifies live resource health, recent logs, and the
          app runs correlated to that service in one pane. */}
      {selectedService && (
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Server className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">
              GCP Resource — <span className="font-mono">{selectedService}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {gcpResource.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading resource…</p>
            ) : gcpResource.isError ? (
              <p className="text-xs text-rose-600 dark:text-rose-400">
                Failed to load GCP resource detail.
              </p>
            ) : (
              <>
                {/* Resource */}
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Resource
                  </div>
                  {gcpResource.data?.health == null ? (
                    <p className="text-xs text-muted-foreground">Resource health unavailable.</p>
                  ) : (
                    <div className="space-y-1.5 text-xs">
                      <div className="flex flex-wrap items-center gap-3">
                        <StatusBadge
                          variant={gcpResource.data.health.health === "healthy" ? "success" : "danger"}
                        >
                          {gcpResource.data.health.health}
                        </StatusBadge>
                        <span className="text-muted-foreground">
                          ready: <span className="font-medium text-foreground">{String(gcpResource.data.health.ready)}</span>
                        </span>
                        {gcpResource.data.health.revision && (
                          <span className="font-mono text-muted-foreground" title={gcpResource.data.health.revision}>
                            {gcpResource.data.health.revision}
                          </span>
                        )}
                        {gcpResource.data.health.url && (
                          <a
                            href={gcpResource.data.health.url}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate text-primary underline-offset-2 hover:underline"
                          >
                            {gcpResource.data.health.url}
                          </a>
                        )}
                      </div>
                      {gcpResource.data.health.conditions.length > 0 && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {gcpResource.data.health.conditions.map((c, i) => (
                            <span key={i} className="flex items-center gap-1.5 text-muted-foreground">
                              <span className="font-medium text-foreground">{c.type ?? "condition"}</span>
                              <WarnableBadge variant={conditionVariant(c.status)}>
                                {c.status ?? "unknown"}
                              </WarnableBadge>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Logs */}
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Logs
                  </div>
                  {(gcpResource.data?.logs ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No recent logs.</p>
                  ) : (
                    <ul className="space-y-1">
                      {(gcpResource.data?.logs ?? []).slice(0, 20).map((l, i) => (
                        <li key={i} className="flex items-center gap-2 text-xs">
                          <WarnableBadge variant={logSeverityVariant(l.severity)}>
                            {l.severity ?? "INFO"}
                          </WarnableBadge>
                          <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                            {relTime(l.timestamp)}
                          </span>
                          <span className="min-w-0 flex-1 truncate" title={l.message ?? undefined}>
                            {l.message ?? "—"}
                          </span>
                          {l.traceId && (
                            <span
                              className="shrink-0 font-mono text-[10px] text-muted-foreground"
                              title={l.traceId}
                            >
                              {l.traceId.slice(0, 8)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* App runs (correlation) */}
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    App runs
                  </div>
                  {(gcpResource.data?.runs ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No correlated runs yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {(gcpResource.data?.runs ?? []).slice(0, 15).map((r) => (
                        <li key={r.runId} className="flex items-center justify-between gap-2 text-xs">
                          <span className="min-w-0 flex-1 truncate font-mono" title={r.runId}>
                            {r.runId.slice(0, 12)}
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                            <span className="tabular-nums">{relTime(r.startedAt)}</span>
                            <span className="tabular-nums">{formatDuration(r.durationMs)}</span>
                            <StatusBadge variant={runStatusVariant(r.status ?? "unknown")}>
                              {r.status ?? "unknown"}
                            </StatusBadge>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
