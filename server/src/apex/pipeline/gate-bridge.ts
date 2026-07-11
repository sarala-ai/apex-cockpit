/**
 * gate:* → approvals bridge (apex-tower migration — Task 2 §2b).
 *
 * Our `Stage` machine BLOCKS at `gate:*` stages until a human decides. The fork
 * already has a mature HITL surface — the `approvals` table + Approvals pages.
 * So instead of a parallel gate store, when a case lands on one of our review
 * (`gate:*`) stages we open an `approvals` row (`type:'pipeline_gate'`,
 * `payload:{caseId, pipelineId, stage, expectedVersion}`); the Approvals page
 * renders it, and `POST /approvals/:id/{approve,reject}` drives our `GateDecision`
 * by transitioning the case forward (approve) or to `failed` (reject).
 *
 * Our third decision — `edit` (revise the spec/plan artifact in place, no fork
 * analog) — is carried on the approve call via the `editedBody` field added to
 * `resolveApprovalSchema`. We map it onto the fork's OWN review-with-edits path:
 * `reviewCase` already accepts an `edits` object applied atomically before the
 * transition, so an approve+`editedBody` writes the revised artifact to the
 * case `summary` (the human-facing artifact surface) and then advances — our
 * `edit` then `approve`, with no new document plumbing. See `resolveGateApproval`.
 */

import { and, asc, eq } from "drizzle-orm";
import {
  approvals,
  pipelineCases,
  pipelineStages,
  type Db,
} from "@paperclipai/db";
import { pipelineService, type PipelineActor } from "../../services/pipelines.js";

/** Our review-stage keys, in gate order. Maps back to the `gate:*` Stage names. */
export const GATE_STAGE_KEYS = ["spec_review", "plan_review", "pr_review"] as const;
export type GateStageKey = (typeof GATE_STAGE_KEYS)[number];

/** The `gate:*` Stage name each review-stage key stands in for (audit clarity). */
export const GATE_STAGE_LABEL: Record<GateStageKey, string> = {
  spec_review: "gate:spec_review",
  plan_review: "gate:plan_review",
  pr_review: "gate:pr_review",
};

/** Which gates accept an `edit` (revised-artifact) decision. PR review is
 * approve/reject only — there is no local artifact to revise. */
const GATE_ACCEPTS_EDIT: Record<GateStageKey, boolean> = {
  spec_review: true,
  plan_review: true,
  pr_review: false,
};

export function isGateStageKey(key: string | null | undefined): key is GateStageKey {
  return !!key && (GATE_STAGE_KEYS as readonly string[]).includes(key);
}

type CaseStageRow = {
  caseId: string;
  pipelineId: string;
  version: number;
  stageKey: string;
  stageKind: string;
};

async function loadCaseStage(db: Db, companyId: string, caseId: string): Promise<CaseStageRow | null> {
  const row = await db
    .select({
      caseId: pipelineCases.id,
      pipelineId: pipelineCases.pipelineId,
      version: pipelineCases.version,
      stageKey: pipelineStages.key,
      stageKind: pipelineStages.kind,
    })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .where(and(eq(pipelineCases.companyId, companyId), eq(pipelineCases.id, caseId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row;
}

/**
 * If `caseId` currently sits on a `gate:*` (review) stage and no OPEN gate
 * approval exists for it yet, create one. Idempotent: a pending/revision gate
 * approval for the same case is not duplicated. Returns the approval id (new or
 * existing) or null when the case is not on a gate.
 */
export async function openGateApprovalIfNeeded(
  db: Db,
  input: { companyId: string; caseId: string; requestedByAgentId?: string | null },
): Promise<string | null> {
  const stage = await loadCaseStage(db, input.companyId, input.caseId);
  if (!stage || !isGateStageKey(stage.stageKey)) return null;

  const open = await db
    .select({ id: approvals.id, payload: approvals.payload, status: approvals.status })
    .from(approvals)
    .where(and(eq(approvals.companyId, input.companyId), eq(approvals.type, "pipeline_gate")))
    .then((rows) =>
      rows.find(
        (r) =>
          (r.status === "pending" || r.status === "revision_requested") &&
          (r.payload as { caseId?: string }).caseId === input.caseId,
      ),
    );
  if (open) return open.id;

  const now = new Date();
  const [created] = await db
    .insert(approvals)
    .values({
      companyId: input.companyId,
      type: "pipeline_gate",
      requestedByAgentId: input.requestedByAgentId ?? null,
      status: "pending",
      payload: {
        caseId: input.caseId,
        pipelineId: stage.pipelineId,
        stage: GATE_STAGE_LABEL[stage.stageKey],
        stageKey: stage.stageKey,
        expectedVersion: stage.version,
      },
      decisionNote: null,
      updatedAt: now,
    })
    .returning();
  return created!.id;
}

/**
 * Resolve a gate approval into a case transition. Called from the approvals
 * approve/reject route AFTER the approval row itself has been marked
 * approved/rejected. `decision` is the fork's binary approve/reject; `editedBody`
 * (approve-only) carries our `edit` decision's revised artifact body.
 *
 * approve            → transition the case to the stage's approveToStageKey.
 * approve+editedBody → write the revised body to the gate's artifact document,
 *                      then transition forward (our `edit` then `approve`).
 * reject             → transition the case to `failed` (rejectToStageKey).
 *
 * A best-effort operation: any failure is surfaced to the caller (never swallowed)
 * but does not roll back the already-recorded approval decision.
 */
export async function resolveGateApproval(
  db: Db,
  input: {
    companyId: string;
    payload: Record<string, unknown>;
    decision: "approve" | "reject";
    editedBody?: string | null;
    actor: PipelineActor;
  },
): Promise<{ transitioned: boolean; toStageKey?: string; note?: string }> {
  const caseId = typeof input.payload.caseId === "string" ? input.payload.caseId : null;
  if (!caseId) return { transitioned: false, note: "gate approval payload missing caseId" };

  const stage = await loadCaseStage(db, input.companyId, caseId);
  if (!stage) return { transitioned: false, note: `case ${caseId} not found` };
  if (!isGateStageKey(stage.stageKey)) {
    // Case already moved on (e.g. a duplicate decision) — nothing to do.
    return { transitioned: false, note: `case ${caseId} is at ${stage.stageKey}, not a gate` };
  }

  const svc = pipelineService(db);

  // `edit` (approve + revised artifact): apply the revised body to the case
  // `summary` in the SAME reviewCase transaction via its `edits` hook, then
  // advance. Only spec/plan gates carry an editable artifact.
  const applyEdit =
    input.decision === "approve" &&
    input.editedBody != null &&
    GATE_ACCEPTS_EDIT[stage.stageKey];

  // Reject → the review stage's rejectToStageKey (our `failed`); approve →
  // approveToStageKey. reviewCase reads those targets from the stage config the
  // seed helper wrote, so we never re-derive them here.
  const result = await svc.reviewCase({
    companyId: input.companyId,
    caseId,
    decision: input.decision === "approve" ? "approve" : "reject",
    expectedVersion: stage.version,
    reason: input.decision === "reject" ? "gate rejected" : null,
    edits: applyEdit ? { summary: input.editedBody! } : undefined,
    actor: input.actor,
  });

  const toStageKey = (result as { stage?: { key?: string } })?.stage?.key;
  return { transitioned: true, toStageKey };
}
