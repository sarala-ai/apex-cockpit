// Shared formatting + small presentational idioms for the Observe surface —
// extracted from Observe.tsx so the Run detail page (and any future Observe
// sub-page) renders the same run-status colors, duration/token formatting,
// and eval verdict pills rather than re-deriving its own conventions.

import { Badge } from "@/components/ui/badge";
import { StatusBadge, type StatusVariant } from "@/apex/status-badge";
import type { EvalVerdict } from "@paperclipai/shared";

export function runStatusVariant(s: string) {
  const v = s.toLowerCase();
  if (["succeeded", "completed", "passed", "success", "done"].includes(v)) return "success" as const;
  if (["failed", "error", "cancelled", "canceled"].includes(v)) return "danger" as const;
  if (["running", "queued", "in_progress", "pending"].includes(v)) return "info" as const;
  return "default" as const;
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

export function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

export function relTime(iso: string | null): string {
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
// kept as its own map rather than added to StatusBadge since "warn" is
// eval-specific vocabulary.
export const VERDICT_BADGE: Record<EvalVerdict, StatusVariant | "warn"> = {
  pass: "success",
  warn: "warn",
  fail: "danger",
};
export const VERDICT_BAR: Record<EvalVerdict, string> = {
  pass: "bg-emerald-500",
  warn: "bg-amber-500",
  fail: "bg-rose-500",
};
export const VERDICT_LABEL: Record<EvalVerdict, string> = {
  pass: "Pass",
  warn: "Warn",
  fail: "Fail",
};

export function VerdictPill({ verdict }: { verdict: EvalVerdict | null }) {
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

export function ScoreBar({ score, verdict }: { score: number | null; verdict: EvalVerdict | null }) {
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
