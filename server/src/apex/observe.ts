import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { err, ok, type Result } from './errors.js';
import { run } from './exec.js';

// ---------------------------------------------------------------------------
// Recent APEX runs
// ---------------------------------------------------------------------------

export interface ApexRun {
  name: string;
  status: string;
  timestamp: string | null;
  mode: string; // plan | apply
}

interface ApexInstanceRecord {
  instance_name?: string;
  workflow_name?: string;
  status?: string;
  execution_mode?: string;
  updated_at?: string;
  created_at?: string;
}

function normalizeApexInstances(raw: unknown): ApexRun[] {
  // instances.json is an object keyed by instance name; `apex ... --output json`
  // may return either an array or that same object. Handle both.
  const records: ApexInstanceRecord[] = Array.isArray(raw)
    ? (raw as ApexInstanceRecord[])
    : raw && typeof raw === 'object'
      ? (Object.values(raw as Record<string, ApexInstanceRecord>) as ApexInstanceRecord[])
      : [];

  return records
    .map((r) => ({
      name: r.instance_name ?? r.workflow_name ?? 'unknown',
      status: r.status ?? 'unknown',
      timestamp: r.updated_at ?? r.created_at ?? null,
      mode: r.execution_mode ?? 'unknown',
    }))
    .sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
    .slice(0, 10);
}

export async function getApexRuns(): Promise<
  Result<ApexRun[]> & { source: string }
> {
  // Preferred path: `apex state list --output json` if the CLI supports it.
  const cli = await run('apex', ['state', 'list', '--output', 'json']);
  if (cli.status === 'ok') {
    try {
      return { ...ok(normalizeApexInstances(JSON.parse(cli.stdout))), source: 'apex-cli' };
    } catch {
      /* fall through to file fallback */
    }
  }

  // Fallback: read ~/.apex/instances.json directly.
  const path = join(homedir(), '.apex', 'instances.json');
  try {
    const text = await readFile(path, 'utf8');
    return {
      ...ok(normalizeApexInstances(JSON.parse(text))),
      source: 'instances.json',
    };
  } catch {
    return {
      ...err('empty', 'No apex CLI on PATH and no ~/.apex/instances.json found.'),
      source: 'unavailable',
    };
  }
}

// ---------------------------------------------------------------------------
// Recent CI runs (GitHub Actions via gh)
// ---------------------------------------------------------------------------

export interface CiRun {
  databaseId: number;
  displayTitle: string;
  workflowName: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}

export async function getCiRuns(
  repo: string,
): Promise<Result<CiRun[]> & { source: string }> {
  if (!repo) {
    return { ...err('empty', 'Pass ?repo=owner/name to list CI runs.'), source: 'no-repo' };
  }
  const res = await run('gh', [
    'run',
    'list',
    '--repo',
    repo,
    '--limit',
    '10',
    '--json',
    'databaseId,displayTitle,workflowName,status,conclusion,createdAt',
  ]);

  if (res.status === 'missing') {
    return {
      ...err('tool-missing', 'GitHub CLI (gh) is not installed or not on PATH.'),
      source: 'unavailable',
    };
  }
  if (res.status === 'failed') {
    const unauth = /auth|login|token|not logged/i.test(res.stderr);
    return {
      ...err(
        unauth ? 'tool-unauth' : 'tool-failed',
        unauth
          ? 'gh is not authenticated — run `gh auth login`.'
          : `gh run list failed: ${res.stderr.trim().slice(0, 200)}`,
      ),
      source: 'unavailable',
    };
  }
  try {
    return { ...ok(JSON.parse(res.stdout) as CiRun[]), source: 'gh' };
  } catch {
    return {
      ...err('parse-failed', 'Could not parse gh JSON output.'),
      source: 'unavailable',
    };
  }
}

// ---------------------------------------------------------------------------
// Token & cost (SigNoz — Claude Code native OTel metrics)
// ---------------------------------------------------------------------------

export interface TokenSummary {
  tokens: number;
  costUsd: number;
  /** Optional coarse time-series buckets [epochMs, value]. */
  series: Array<[number, number]>;
}

const TOKEN_METRIC = 'claude_code.token.usage';
const COST_METRIC = 'claude_code.cost.usage';

/**
 * Best-effort query of SigNoz's query-range API for today's Claude Code token
 * and cost totals. A graceful empty state is an accepted PASS for v0.1, so any
 * unreachable/empty condition returns a classified empty rather than throwing.
 */
export async function getTokens(): Promise<
  Result<TokenSummary> & { source: string; hint?: string }
> {
  const enableHint =
    'No Claude Code telemetry yet. Set CLAUDE_CODE_ENABLE_TELEMETRY=1 and point ' +
    'OTEL_EXPORTER_OTLP_ENDPOINT at local SigNoz (see README), then run Claude Code.';

  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;

  const buildQuery = (metric: string) => ({
    start,
    end: now,
    step: 3600,
    compositeQuery: {
      queryType: 'builder',
      panelType: 'value',
      builderQueries: {
        A: {
          queryName: 'A',
          dataSource: 'metrics',
          aggregateOperator: 'sum',
          aggregateAttribute: { key: metric, type: 'Sum' },
          timeAggregation: 'sum',
          spaceAggregation: 'sum',
          expression: 'A',
          disabled: false,
        },
      },
    },
  });

  const queryOne = async (metric: string): Promise<number | null> => {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4000);
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (config.signozApiKey) headers['SIGNOZ-API-KEY'] = config.signozApiKey;
      const resp = await fetch(`${config.signozUrl}/api/v4/query_range`, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildQuery(metric)),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!resp.ok) return null;
      const json = (await resp.json()) as unknown;
      // SigNoz value-panel shape: data.result[0].series[0].values[].value
      const series =
        (json as any)?.data?.result?.[0]?.series?.[0]?.values ??
        (json as any)?.data?.newResult?.data?.result?.[0]?.series?.[0]?.values;
      if (!Array.isArray(series) || series.length === 0) return 0;
      return series.reduce(
        (acc: number, v: any) => acc + Number(v?.value ?? 0),
        0,
      );
    } catch {
      return null; // unreachable / aborted
    }
  };

  const [tokens, cost] = await Promise.all([
    queryOne(TOKEN_METRIC),
    queryOne(COST_METRIC),
  ]);

  if (tokens === null && cost === null) {
    return {
      ...err('unreachable', `SigNoz not reachable at ${config.signozUrl}.`),
      source: 'signoz-empty',
      hint: enableHint,
    };
  }
  const t = tokens ?? 0;
  const c = cost ?? 0;
  if (t === 0 && c === 0) {
    return {
      ...ok({ tokens: 0, costUsd: 0, series: [] }),
      source: 'signoz-empty',
      hint: enableHint,
    };
  }
  return {
    ...ok({ tokens: t, costUsd: c, series: [] }),
    source: 'signoz',
  };
}
