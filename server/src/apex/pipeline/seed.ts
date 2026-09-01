/**
 * Seed our fixed ticket-lifecycle Stage machine (spec 002) as fork pipeline rows
 * (apex-tower migration — Task 2 §2a).
 *
 * Our hand-built `Stage` enum
 *   ingested → specifying → gate:spec_review → planning → gate:plan_review →
 *   executing → gate:pr_review → done / failed
 * becomes ONE `pipelines` row + 9 `pipelineStages` rows + linear
 * `pipelineTransitions`. This is CONFIG, not code — it runs through the fork's
 * existing `pipelineService` (createPipeline/createTransition), NO schema change.
 *
 * `kind` mapping (per the migration doc):
 *   ingested/specifying/planning/executing → 'working'
 *   gate:*                                  → 'review'
 *   done                                    → 'done'
 *   failed                                  → 'cancelled'
 *
 * Stage keys drop the `gate:` colon (fork stage keys are plain identifiers); the
 * mapping back to our `Stage` names lives in `gate-bridge.ts`.
 */

import { and, eq } from "drizzle-orm";
import { pipelines } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { pipelineService, type PipelineActor } from "../../services/pipelines.js";

/** The stable pipeline key we look the seeded pipeline up by (idempotency). */
export const APEX_TOWER_PIPELINE_KEY = "apex-tower-lifecycle";

/**
 * The 9 stages, in order. `review` stages carry approve/reject targets so the
 * fork's review-stage validation (`assertReviewTargetsInSet`) passes and so a
 * gate approval/reject advances the case along our happy path (approve) or to
 * `failed` (reject).
 */
const STAGES = [
  { key: "ingested", name: "Ingested", kind: "working" as const },
  { key: "specifying", name: "Specifying", kind: "working" as const },
  {
    key: "spec_review",
    name: "Spec review",
    kind: "review" as const,
    config: {
      approveToStageKey: "planning",
      rejectToStageKey: "failed",
      requireApproval: true,
      approver: { kind: "any_human" as const },
    },
  },
  { key: "planning", name: "Planning", kind: "working" as const },
  {
    key: "plan_review",
    name: "Plan review",
    kind: "review" as const,
    config: {
      approveToStageKey: "executing",
      rejectToStageKey: "failed",
      requireApproval: true,
      approver: { kind: "any_human" as const },
    },
  },
  { key: "executing", name: "Executing", kind: "working" as const },
  {
    key: "pr_review",
    name: "PR review",
    kind: "review" as const,
    config: {
      approveToStageKey: "done",
      rejectToStageKey: "failed",
      requireApproval: true,
      approver: { kind: "any_human" as const },
    },
  },
  { key: "done", name: "Done", kind: "done" as const },
  { key: "failed", name: "Failed", kind: "cancelled" as const },
];

/** Linear happy path plus every gate's reject → failed edge. */
const TRANSITIONS: Array<{ from: string; to: string }> = [
  { from: "ingested", to: "specifying" },
  { from: "specifying", to: "spec_review" },
  { from: "spec_review", to: "planning" },
  { from: "spec_review", to: "failed" },
  { from: "planning", to: "plan_review" },
  { from: "plan_review", to: "executing" },
  { from: "plan_review", to: "failed" },
  { from: "executing", to: "pr_review" },
  { from: "executing", to: "failed" },
  { from: "pr_review", to: "done" },
  { from: "pr_review", to: "failed" },
];

/**
 * Idempotently seed the lifecycle pipeline for a company. If a pipeline with our
 * key already exists it is returned unchanged (no duplicate rows). Returns the
 * pipeline id + a stage-key → stage-id map callers can reuse.
 */
export async function seedApexTowerPipeline(
  db: Db,
  input: { companyId: string; projectId?: string | null; actor?: PipelineActor },
): Promise<{ pipelineId: string; created: boolean; stageIdByKey: Record<string, string> }> {
  const svc = pipelineService(db);
  const actor: PipelineActor = input.actor ?? { type: "system" };

  const already = await db
    .select({ id: pipelines.id })
    .from(pipelines)
    .where(and(eq(pipelines.companyId, input.companyId), eq(pipelines.key, APEX_TOWER_PIPELINE_KEY)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (already) {
    const stages = await svc.listStages(input.companyId, already.id);
    return {
      pipelineId: already.id,
      created: false,
      stageIdByKey: Object.fromEntries(stages.map((s) => [s.key, s.id])),
    };
  }

  const pipeline = await svc.createPipeline({
    companyId: input.companyId,
    key: APEX_TOWER_PIPELINE_KEY,
    name: "APEX Tower ticket lifecycle",
    description: "ingest → spec → plan → execute, with HITL gates (spec 002)",
    projectId: input.projectId ?? null,
    enforceTransitions: true,
    stages: STAGES.map((s, i) => ({
      key: s.key,
      name: s.name,
      kind: s.kind,
      position: (i + 1) * 100,
      config: "config" in s ? s.config : {},
    })),
    actor,
  });

  const stageIdByKey = Object.fromEntries(pipeline.stages.map((s) => [s.key, s.id]));

  // createPipeline only auto-seeds transitions for the DEFAULT stage set; with
  // our explicit stages we wire the linear happy path + gate→failed edges here.
  for (const edge of TRANSITIONS) {
    await svc.createTransition({
      companyId: input.companyId,
      pipelineId: pipeline.id,
      fromStageId: stageIdByKey[edge.from]!,
      toStageId: stageIdByKey[edge.to]!,
    });
  }

  return { pipelineId: pipeline.id, created: true, stageIdByKey };
}
