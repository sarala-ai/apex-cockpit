import { Activity, Coins, GitBranch, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  api,
  type ApexRunsResponse,
  type CiRunsResponse,
  type TokensResponse,
} from '@/lib/api';

const DEFAULT_REPO = 'sarala-ai/apex';

/** Generic async loader hook for a card. */
function useCard<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(() => {
    setLoading(true);
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(run, [run]);
  return { data, error, loading, reload: run };
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
        <CardTitle className="flex items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </CardTitle>
        <button
          onClick={onReload}
          className="text-muted-foreground transition hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Empty({ note }: { note?: string }) {
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      {note ?? 'No data yet.'}
    </p>
  );
}

function statusVariant(s: string, conclusion?: string | null) {
  const v = (conclusion || s).toLowerCase();
  if (['success', 'completed', 'passed'].includes(v)) return 'success' as const;
  if (['failure', 'failed', 'error', 'cancelled'].includes(v)) return 'danger' as const;
  if (['in_progress', 'queued', 'running', 'pending'].includes(v)) return 'info' as const;
  return 'default' as const;
}

// --- Card: Token & cost -----------------------------------------------------
function TokenCard() {
  const { data, loading, reload } = useCard<TokensResponse>(api.tokens);
  const empty = !data || data.source !== 'signoz';
  return (
    <CardShell icon={<Coins className="h-4 w-4" />} title="Token & cost" onReload={reload} loading={loading}>
      {empty ? (
        <Empty note={data?.hint ?? data?.note} />
      ) : (
        <div className="flex items-baseline gap-6">
          <div>
            <div className="text-2xl font-semibold tabular-nums">
              {data!.tokens.toLocaleString()}
            </div>
            <div className="text-xs text-muted-foreground">tokens (24h)</div>
          </div>
          <div>
            <div className="text-2xl font-semibold tabular-nums">
              ${data!.costUsd.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">cost (24h)</div>
          </div>
        </div>
      )}
    </CardShell>
  );
}

// --- Card: Recent APEX runs -------------------------------------------------
function ApexCard() {
  const { data, loading, reload } = useCard<ApexRunsResponse>(api.apexRuns);
  const runs = data?.runs ?? [];
  return (
    <CardShell icon={<Activity className="h-4 w-4" />} title="Recent APEX runs" onReload={reload} loading={loading}>
      {runs.length === 0 ? (
        <Empty note={data?.note ?? 'No APEX instances found.'} />
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r) => (
            <li key={r.name} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-medium" title={r.name}>
                {r.name}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Badge variant="default">{r.mode}</Badge>
                <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
      {data?.source && (
        <p className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
          source: {data.source}
        </p>
      )}
    </CardShell>
  );
}

// --- Card: Recent CI runs ---------------------------------------------------
function CiCard() {
  const { data, loading, reload } = useCard<CiRunsResponse>(() =>
    api.ciRuns(DEFAULT_REPO),
  );
  const runs = data?.runs ?? [];
  return (
    <CardShell icon={<GitBranch className="h-4 w-4" />} title="Recent CI runs" onReload={reload} loading={loading}>
      <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground/60">
        {DEFAULT_REPO}
      </p>
      {runs.length === 0 ? (
        <Empty note={data?.note ?? 'No CI runs found.'} />
      ) : (
        <ul className="space-y-1.5">
          {runs.map((r) => (
            <li key={r.databaseId} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate" title={r.displayTitle}>
                {r.workflowName}
              </span>
              <Badge variant={statusVariant(r.status, r.conclusion)}>
                {r.conclusion || r.status}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
}

export function ObservePane() {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-3 text-xs text-muted-foreground">
        What did my agents do, and what did it cost?
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <TokenCard />
        <ApexCard />
        <CiCard />
      </div>
    </div>
  );
}
