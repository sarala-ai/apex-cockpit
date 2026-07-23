// APEX / CI run observability client (apex-tower migration — Task 2 §3b).
//
// Talks to the Express `/api/observe/*` routes (server/src/routes/apex-observe.ts):
// APEX workflow instance status + GitHub Actions run status. These are the infra-
// run (Ops) side of Observe, distinct from the fork's LLM token/spend Costs. Both
// endpoints return `{ runs, source, note? }` and never error-status, so callers
// render `note` as guidance rather than handling failures.

import { api } from "./client";

export interface ApexRun {
  name: string;
  status: string;
  timestamp: string | null;
  mode: string; // plan | apply
}

export interface CiRun {
  databaseId: number;
  displayTitle: string;
  workflowName: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
}

export interface AgentRunUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
  model: string | null;
}

export interface AgentRun {
  id: string;
  agentName: string;
  issueId: string | null;
  issueTitle: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stopReason: string | null;
  usage: AgentRunUsage | null;
}

export interface AgentRunsResponse {
  runs: AgentRun[];
  source: string;
  note?: string;
}

export interface ApexRunsResponse {
  runs: ApexRun[];
  source: string;
  note?: string;
}
export interface CiRunsResponse {
  runs: CiRun[];
  source: string;
  note?: string;
}

export const apexObserveApi = {
  agentRuns: () => api.get<AgentRunsResponse>("/observe/agent-runs"),
  apexRuns: () => api.get<ApexRunsResponse>("/observe/apex-runs"),
  ciRuns: (repo: string) =>
    api.get<CiRunsResponse>(
      `/observe/ci-runs${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`,
    ),
};
