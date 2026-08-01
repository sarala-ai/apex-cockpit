import { z } from "zod";
import { APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
  // apex-tower (Task 2 §2b): our gate `edit` decision has no fork analog. An
  // approve carrying `editedBody` revises the case's spec/plan artifact in place
  // before the gate advances it. Ignored for non-`pipeline_gate` approvals.
  editedBody: multilineTextSchema.optional().nullable(),
  // Which of the gate's review passes the approver actually ticked
  // (docs/architecture/review-passes.md). Recorded, never required: a tick is
  // evidence the question was read, and an always-empty list over time is the
  // evidence that this mechanism should be deleted rather than layered on.
  // Ids are apex-core's, not re-validated here — the cockpit is not the
  // vocabulary's owner and an unknown id must not fail a founder's decision.
  acknowledgedReviewPasses: z.array(z.string().min(1).max(64)).max(20).optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
