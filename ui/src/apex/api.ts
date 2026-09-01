// Sidecar client. All calls go through the Vite dev proxy (`/api` -> sidecar).

export interface ApexRun {
  name: string;
  status: string;
  timestamp: string | null;
  mode: string;
}
export interface ApexRunsResponse {
  runs: ApexRun[];
  source: string;
  note?: string;
}

export interface CiRun {
  databaseId: number;
  displayTitle: string;
  workflowName: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}
export interface CiRunsResponse {
  runs: CiRun[];
  source: string;
  note?: string;
}

export interface TokensResponse {
  tokens: number;
  costUsd: number;
  series: Array<[number, number]>;
  source: string;
  note?: string;
  hint?: string;
}

// --- Pipeline (spec 002) ----------------------------------------------------

export type Stage =
  | 'ingested'
  | 'specifying'
  | 'gate:spec_review'
  | 'planning'
  | 'gate:plan_review'
  | 'executing'
  | 'gate:pr_review'
  | 'done'
  | 'failed';

export type GateDecision =
  | { kind: 'approve' }
  | { kind: 'edit'; body: string }
  | { kind: 'reject'; reason: string };

export interface Ticket {
  id: string;
  source: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  status: string;
}
export interface Artifact {
  kind: 'spec' | 'plan';
  body: string;
  tokens?: number;
  costUsd?: number;
}
export interface Task {
  id: string;
  title: string;
  workflow: string;
  params: Record<string, string>;
  status: 'pending' | 'running' | 'passed' | 'failed';
}
export interface GateRecord {
  stage: Stage;
  decision: GateDecision;
  at: string;
}
export interface Run {
  runId: string;
  ticket: Ticket;
  stage: Stage;
  spec?: Artifact;
  plan?: Artifact;
  tasks: Task[];
  gates: GateRecord[];
  prUrl?: string;
  failure?: { step: string; message: string };
}

export interface TicketsResponse {
  tickets: Ticket[];
  source: string;
  note?: string;
}

// --- Company setup (spec 003) -----------------------------------------------

export interface AuthStatus {
  google: { authed: boolean; account: string | null };
  github: { authed: boolean; user: string | null };
}
export interface GcpProject { projectId: string; name: string; projectNumber: string }
export interface GcpOrg { id: string; displayName: string }
export interface GhOrg { login: string; id: number }
export interface GhRepo { name: string; nameWithOwner: string; visibility: string; url: string }
export interface Org {
  id: string;
  name: string;
  provider: string;
  googleOrg?: { id: string; displayName: string };
  githubOrg?: string;
  createdAt: string;
}
export interface Company {
  id: string;
  orgId: string;
  name: string;
  gcpProjects: string[];
  githubRepos: string[];
  createdAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `${path} -> HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  apexRuns: () => getJson<ApexRunsResponse>('/observe/apex-runs'),
  ciRuns: (repo: string) =>
    getJson<CiRunsResponse>(`/observe/ci-runs?repo=${encodeURIComponent(repo)}`),
  tokens: () => getJson<TokensResponse>('/observe/tokens'),

  pipelineTickets: (repo: string) =>
    getJson<TicketsResponse>(`/pipeline/tickets?repo=${encodeURIComponent(repo)}`),
  pipelineRuns: () => getJson<{ runs: Run[] }>('/pipeline/runs'),
  pipelineIngest: (repo: string, number: number) =>
    postJson<{ run: Run }>('/pipeline/ingest', { repo, number }),
  pipelineDecide: (runId: string, decision: GateDecision) =>
    postJson<{ run: Run }>('/pipeline/decide', { runId, decision }),

  // Company setup — auth + discovery + org/company registry
  setupAuth: () => getJson<AuthStatus>('/setup/auth'),
  gcpProjects: () => getJson<{ projects: GcpProject[]; note?: string }>('/setup/gcp/projects'),
  gcpOrgs: () => getJson<{ orgs: GcpOrg[]; note?: string }>('/setup/gcp/orgs'),
  githubOrgs: () => getJson<{ orgs: GhOrg[]; note?: string }>('/setup/github/orgs'),
  githubRepos: (org: string) =>
    getJson<{ repos: GhRepo[]; note?: string }>(`/setup/github/repos?org=${encodeURIComponent(org)}`),
  orgs: () => getJson<{ orgs: Org[] }>('/orgs'),
  createOrg: (body: Partial<Org>) => postJson<{ org: Org }>('/orgs', body),
  companies: (orgId?: string) =>
    getJson<{ companies: Company[] }>(`/companies${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`),
  createCompany: (body: { orgId: string; name: string; gcpProjects: string[]; githubRepos: string[] }) =>
    postJson<{ company: Company }>('/companies', body),
};

/** WebSocket URL to advance a run one stage, streaming agent/exec output. */
export function stepUrl(runId: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/pipeline/step?runId=${encodeURIComponent(runId)}`;
}

/** WebSocket URL for the PTY, same-origin so the Vite proxy upgrades it. */
export function ptyUrl(cols: number, rows: number, cmd?: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ cols: String(cols), rows: String(rows) });
  if (cmd) params.set('cmd', cmd);
  return `${proto}://${location.host}/pty?${params.toString()}`;
}
