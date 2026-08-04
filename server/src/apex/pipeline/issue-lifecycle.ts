/**
 * What a TICKET says about the process it is running on.
 *
 * The shaping lives apart from the query so the interesting decision — when a
 * ticket is allowed to claim a human decision is outstanding — is testable
 * without a database.
 *
 * The source of truth is the pipeline case reached through the issue-link
 * table. The `issues.flow*` columns are the retired flow mirror: they are null
 * for every pipeline case, so reading them reports "the lifecycle never
 * started" about tickets that are demonstrably mid-flight.
 */
import type { pipelineCaseIssueLinks, pipelineCases, pipelineStages, pipelines } from "@paperclipai/db";
import { reviewConfigForStage } from "../../services/pipelines.js";

type LinkRow = typeof pipelineCaseIssueLinks.$inferSelect;
type CaseRow = typeof pipelineCases.$inferSelect;
type PipelineRow = typeof pipelines.$inferSelect;
type StageRow = typeof pipelineStages.$inferSelect;

/**
 * The gate's own question, in the words whoever built the process wrote.
 *
 * Null when the gate declared none — the surface then says so plainly rather
 * than inventing a question the process never asked.
 */
export function reviewStageQuestion(stage: Pick<StageRow, "config">): string | null {
  const config = stage.config as Record<string, unknown> | null | undefined;
  const gate = config?.gate;
  if (!gate || typeof gate !== "object" || Array.isArray(gate)) return null;
  const prompt = (gate as Record<string, unknown>).prompt;
  return typeof prompt === "string" && prompt.trim().length > 0 ? prompt.trim() : null;
}

/**
 * A decision is outstanding only when the case is sitting at a review stage AND
 * has not reached a terminal state. A finished case that ENDED on a review
 * stage is history, not a request: showing it as pending would put a decision
 * on the ticket that nobody can make.
 */
export function isAwaitingHumanDecision(
  caseRow: Pick<CaseRow, "terminalKind">,
  stage: Pick<StageRow, "kind">,
): boolean {
  return stage.kind === "review" && caseRow.terminalKind === null;
}

export function shapeIssueLinkedCase(row: {
  link: Pick<LinkRow, "role">;
  case: Pick<CaseRow, "id" | "caseKey" | "title" | "terminalKind" | "version">;
  pipeline: Pick<PipelineRow, "id" | "key" | "name">;
  stage: StageRow;
}) {
  const awaitingDecision = isAwaitingHumanDecision(row.case, row.stage);
  return {
    id: row.case.id,
    caseKey: row.case.caseKey,
    title: row.case.title,
    status: row.case.terminalKind ?? "open",
    role: row.link.role,
    /** Required by `POST /cases/:id/review`; without it the ticket can show a
     *  decision it has no way to submit. */
    version: row.case.version,
    terminalKind: row.case.terminalKind,
    pipeline: {
      id: row.pipeline.id,
      key: row.pipeline.key,
      name: row.pipeline.name,
    },
    stage: {
      id: row.stage.id,
      key: row.stage.key,
      name: row.stage.name,
      kind: row.stage.kind,
    },
    /** Present only while a decision is genuinely outstanding, so no surface
     *  has to infer "does this need me?" from a stage kind. */
    review: awaitingDecision
      ? {
        question: reviewStageQuestion(row.stage),
        config: safeReviewConfig(row.stage),
      }
      : null,
  };
}

/**
 * `reviewConfigForStage` REJECTS a review stage whose config is incomplete —
 * correct when someone is editing a pipeline, wrong here. This runs inside the
 * issue detail response, and a stage config the validator dislikes must not
 * take the whole ticket down with a 500.
 *
 * It degrades to no config, never to no review. The ticket still says a
 * decision is pending and still links to where it is made; it just cannot
 * offer buttons whose targets it failed to derive. Silently dropping `review`
 * would hide a pending decision, which is the exact failure this surface was
 * built to fix.
 */
function safeReviewConfig(stage: StageRow): Record<string, unknown> {
  try {
    return reviewConfigForStage(stage) as Record<string, unknown>;
  } catch {
    return {};
  }
}
