/**
 * What a human is allowed to decide at a review stage, and what each decision
 * does next.
 *
 * This lived inside the pipeline board page for as long as the board was the
 * only place a gate could be decided. It is shared now because the TICKET is
 * where a person actually looks when something is waiting on them — the board
 * is where they look once they already know pipelines exist. Both surfaces must
 * offer the same decisions with the same wording and the same reason rules, so
 * the rules live here once rather than being restated per surface.
 *
 * The decisions are DERIVED from the stage's own config, never assumed. A gate
 * that declares no `requestChangesToStageKey` genuinely has no "request
 * changes" — rendering the button anyway would offer a decision the server
 * would refuse.
 */
import { humanizePipelineItemStatus } from "./pipeline-item-detail";
import type { PipelineReviewDecision, PipelineStage } from "../api/pipelines";

export interface ReviewDecisionConfig {
  approveToStageKey: string | null;
  rejectToStageKey: string | null;
  requestChangesToStageKey: string | null;
  requireRejectReason: boolean;
  requireRequestChangesReason: boolean;
}

export interface ReviewDecisionAction {
  decision: PipelineReviewDecision;
  label: string;
  targetStageName: string;
  targetStageKey: string;
  requireReason: boolean;
  variant: "default" | "outline" | "destructive";
}

function configString(config: Record<string, unknown> | null | undefined, key: string) {
  const value = config?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The question a review stage asks, in the words whoever built the process
 * wrote. Null when it declared none — the surface then says nothing rather
 * than inventing a question that was never asked.
 *
 * Only ever a FALLBACK now: the decision brief carries the same question
 * alongside the artifact it is about. This is what a person sees when no
 * brief can be had, which is the state the product was in before the brief
 * existed — reached deliberately instead of by an empty render.
 */
export function reviewStageQuestion(stage: Pick<PipelineStage, "config">): string | null {
  const gate = (stage.config as Record<string, unknown> | null | undefined)?.gate;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
  const prompt = (gate as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.trim().length > 0 ? prompt.trim() : null;
}

function stageKeyForKind(stages: PipelineStage[], kind: string) {
  return stages.find((stage) => stage.kind === kind)?.key ?? stages.find((stage) => stage.key === kind)?.key ?? null;
}

export function reviewDecisionConfig(stage: PipelineStage, stages: PipelineStage[]): ReviewDecisionConfig | null {
  if (stage.kind !== "review") return null;
  return reviewDecisionConfigFromStageConfig(stage.config, stages);
}

/**
 * The same derivation from a bare stage config object.
 *
 * The ticket surface is handed one stage's normalised config and not the whole
 * pipeline, so the `stages` fallbacks are optional there: the server normalises
 * a review stage to always carry an approve and a reject target, and the
 * fallbacks only matter for a stage config that predates that.
 */
export function reviewDecisionConfigFromStageConfig(
  config: Record<string, unknown> | null | undefined,
  stages: PipelineStage[] = [],
): ReviewDecisionConfig {
  return {
    approveToStageKey: configString(config, "approveToStageKey") ?? stageKeyForKind(stages, "done"),
    rejectToStageKey: configString(config, "rejectToStageKey") ?? stageKeyForKind(stages, "cancelled"),
    requestChangesToStageKey: configString(config, "requestChangesToStageKey"),
    requireRejectReason: config?.requireRejectReason !== false,
    requireRequestChangesReason: config?.requireRequestChangesReason !== false,
  };
}

export function reviewDecisionActions(
  config: ReviewDecisionConfig,
  stageLookup: Map<string, string>,
): ReviewDecisionAction[] {
  const actions: ReviewDecisionAction[] = [];
  if (config.approveToStageKey) {
    actions.push({
      decision: "approve",
      label: "Approve",
      targetStageKey: config.approveToStageKey,
      targetStageName: stageLookup.get(config.approveToStageKey) ?? humanizePipelineItemStatus(config.approveToStageKey),
      requireReason: false,
      variant: "default",
    });
  }
  if (config.requestChangesToStageKey) {
    actions.push({
      decision: "request_changes",
      label: "Request changes",
      targetStageKey: config.requestChangesToStageKey,
      targetStageName: stageLookup.get(config.requestChangesToStageKey) ?? humanizePipelineItemStatus(config.requestChangesToStageKey),
      requireReason: config.requireRequestChangesReason,
      variant: "outline",
    });
  }
  if (config.rejectToStageKey) {
    actions.push({
      decision: "reject",
      label: "Reject",
      targetStageKey: config.rejectToStageKey,
      targetStageName: stageLookup.get(config.rejectToStageKey) ?? humanizePipelineItemStatus(config.rejectToStageKey),
      requireReason: config.requireRejectReason,
      variant: "destructive",
    });
  }
  return actions;
}

export function reviewDecisionToastTitle(decision: PipelineReviewDecision, movedToNextItem: boolean) {
  const prefix = decision === "approve"
    ? "Item approved"
    : decision === "request_changes"
      ? "Changes requested"
      : "Item rejected";
  return movedToNextItem ? `${prefix}; moved to the next review` : prefix;
}
