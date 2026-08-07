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
  /** Unified diff hunks for this file. Absent when the file is binary, when
   *  the diff was too large for GitHub to return, or when the server is
   *  talking to an apex-core that predates the patch extension. */
  patch?: string | null;
  /** A blob, not an empty diff — no line-level view exists for it. */
  binary?: boolean | null;
  /** This file's diff was cut. The renderer must SAY so, never hide it. */
  patch_truncated?: boolean | null;
  /** Present only for design documents the server could read something out
   *  of. Absent means "nothing could be read", NOT "nothing changed" — the
   *  design renderer must say so rather than imply an empty change. */
  design?: {
    /** A rendered image, when one can be produced headlessly. */
    preview?: { label: string; dataUri: string } | null;
    /** Page / board names parsed from the design file itself. */
    boards?: string[] | null;
  } | null;
};

/** What kind of thing the reviewer is looking at. Classified server-side in
 *  `server/src/apex/steps/brief.ts` (`classifyArtifactKind`) — the UI keys its
 *  renderer registry off this value and never re-derives it. */
export type ApprovalArtifactKind = "code" | "design" | "plan" | "doc" | "unknown";
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
      artifactKind: ApprovalArtifactKind;
    };

/** The healthy branch of ApprovalPrDiff — what an artifact renderer receives. */
export type ApprovalArtifact = Extract<ApprovalPrDiff, { degraded: false }>;

/** The gate DECISION BRIEF (server: GET /approvals/:id/brief). Answers,
 *  in decision order: what is being decided → what was already verified →
 *  what to look at → what happens next → who did the work. Machine strings
 *  (raw acceptance declarations, UUIDs, run ids) are confined to
 *  `verified.machine` and `machine`, never to a headline. */
export type ApprovalBriefVerified = {
  headline: string;
  ok: boolean | null;
  machine: string[];
};
export type ApprovalBriefNext = {
  approve: string;
  /** The `request_changes` consequence — which step reruns with the
   *  reviewer's reason. Null when this gate has no step to route back to. */
  requestChanges: string | null;
  reject: string;
  derived: boolean;
  note: string | null;
};
/** One review pass the gate asks, as apex-core defines it. The question text
 *  is authored in apex-core's review_passes.py and travels over the wire — the
 *  cockpit displays doctrine, it does not restate it. */
export type ApprovalBriefReviewPass = {
  id: string;
  label: string;
  question: string;
};
/** Risk + reversibility of approving this gate, derived server-side from the
 *  process definition's post-gate steps. Uses the same "Risks" vocabulary the
 *  board-approval brief already uses. */
export type ApprovalBriefRisk = {
  reversibility: "reversible" | "reversible_with_effort" | "irreversible" | "unknown";
  reversibilityLine: string;
  risks: string[];
  derived: boolean;
};
export type ApprovalBriefProvenance = {
  agentName: string | null;
  agentId: string | null;
  runId: string | null;
  permissionProfile: string | null;
  permissionMode: string | null;
  commissionedAt: string | null;
  verifiedAt: string | null;
  gateOpenedAt: string | null;
};
/**
 * THE PIPELINE GATE BRIEF (server: `apex/steps/gate-brief.ts`).
 *
 * What every gate a seeded lifecycle opens now answers, in place of the
 * one-line `gate.prompt` written at seed time. Assembled deterministically
 * from records that already exist — the step that ran, the document it wrote,
 * the verdict the server recorded, the rounds already spent. No model call
 * produced any of these sentences.
 *
 * The wording is SERVER-SIDE on purpose: three surfaces render this (the
 * ticket, the item page, the approvals page) and a decision must not read
 * three ways.
 */
export type GateBriefOutcome = {
  decision: "approve" | "request_changes" | "reject";
  line: string;
};
export type GateBriefLookAtItem = {
  label: string;
  /** The artifact's own text, cut honestly. Null when it has none (a link). */
  excerpt: string | null;
  truncated: boolean;
  /** A document key on the ticket page — `#document-<anchor>`. */
  anchor: string | null;
  url: string | null;
  meta: string | null;
};
export type PipelineGateBrief = {
  available: true;
  kind: "pipeline_gate";
  deciding: {
    headline: string;
    question: string | null;
    subject: string;
    ticketIdentifier: string | null;
    ticketId: string | null;
    outcomes: GateBriefOutcome[];
    waitingFor: string | null;
  };
  lookAt: {
    headline: string;
    items: GateBriefLookAtItem[];
    /** Absence, stated. Null when there IS something to look at. */
    nothingThere: string | null;
  };
  checked: {
    headline: string;
    ok: boolean | null;
    detail: string | null;
    machine: string[];
  };
  history: string[];
  reviewPasses: ApprovalBriefReviewPass[];
  machine: {
    approvalId: string;
    caseId: string;
    pipelineKey: string;
    stepKey: string;
    workVersion: number;
  };
};

export type FlowGateBrief =
  | { available: false; reason: string }
  | {
      available: true;
      kind: "flow_gate";
      decision: {
        headline: string;
        subject: string | null;
        detail: string | null;
        flowPurpose: string | null;
        ticketIdentifier: string | null;
      };
      verified: ApprovalBriefVerified;
      artifact: ApprovalPrDiff;
      reviewPasses: ApprovalBriefReviewPass[];
      next: ApprovalBriefNext;
      risk: ApprovalBriefRisk;
      provenance: ApprovalBriefProvenance;
      waitingSince: string | null;
      machine: {
        approvalId: string;
        issueId: string;
        flowName: string | null;
        nodeId: string | null;
        ticketType: string | null;
      };
    };

/** One route, two shapes, discriminated by `kind`. A consumer that only
 *  understands one must check it rather than sniff for fields. */
export type ApprovalBrief = FlowGateBrief | PipelineGateBrief;

export const approvalsApi = {
  list: (companyId: string, status?: string) =>
    api.get<Approval[]>(
      `/companies/${companyId}/approvals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    ),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Approval>(`/companies/${companyId}/approvals`, data),
  get: (id: string) => api.get<Approval>(`/approvals/${id}`),
  approve: (id: string, decisionNote?: string, acknowledgedReviewPasses?: string[]) =>
    api.post<Approval>(`/approvals/${id}/approve`, { decisionNote, acknowledgedReviewPasses }),
  reject: (id: string, decisionNote?: string, acknowledgedReviewPasses?: string[]) =>
    api.post<Approval>(`/approvals/${id}/reject`, { decisionNote, acknowledgedReviewPasses }),
  requestRevision: (id: string, decisionNote?: string) =>
    api.post<Approval>(`/approvals/${id}/request-revision`, { decisionNote }),
  resubmit: (id: string, payload?: Record<string, unknown>) =>
    api.post<Approval>(`/approvals/${id}/resubmit`, { payload }),
  listComments: (id: string) => api.get<ApprovalComment[]>(`/approvals/${id}/comments`),
  addComment: (id: string, body: string) =>
    api.post<ApprovalComment>(`/approvals/${id}/comments`, { body }),
  listIssues: (id: string) => api.get<Issue[]>(`/approvals/${id}/issues`),
  getPrDiff: (id: string) => api.get<ApprovalPrDiff>(`/approvals/${id}/pr-diff`),
  getBrief: (id: string) => api.get<ApprovalBrief>(`/approvals/${id}/brief`),
};
