import type { Approval, ApprovalComment, Issue } from "@paperclipai/shared";
import { api } from "./client";

/** github_repo's get_pull_request result, as re-shaped by the server's
 *  GET /approvals/:id/pr-diff route (server/src/routes/approvals.ts) — a
 *  view-time fetch from the PR head, never frozen into the approval
 *  payload. Every failure mode degrades to a structured shape, never a
 *  thrown fetch error, so the UI always has something to render. */
export type ApprovalPrDiffFile = {
  path: string;
  status: string;
  additions: number;
  deletions: number;
};
export type ApprovalPrDiff =
  | { available: false; reason: string }
  | {
      available: true;
      degraded: true;
      repo: string;
      headBranch: string;
      error: string;
      acceptanceEvaluation: string | null;
    }
  | {
      available: true;
      degraded: false;
      repo: string;
      headBranch: string;
      url: string;
      title: string;
      totals: { additions: number; deletions: number; changedFiles: number };
      files: ApprovalPrDiffFile[];
      files_truncated: boolean;
      acceptanceEvaluation: string | null;
    };

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/approve`, { decisionNote }),
  reject: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
  getPrDiff: (id: string) => api.get<ApprovalPrDiff>(`/approvals/${id}/pr-diff`),
};
