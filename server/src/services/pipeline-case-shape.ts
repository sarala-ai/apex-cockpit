/**
 * Turning a database invariant into a TypeScript fact.
 *
 * Since 0167 a case row's `pipeline_id` and `stage_id` are nullable, because a
 * flow-defined case has neither. The check constraint
 * `pipeline_cases_definition_shape_check` guarantees the converse just as
 * strongly: a case with `definition_kind = 'pipeline'` ALWAYS carries both.
 *
 * Pipeline code paths reach their case rows through queries that inner-join
 * `pipelines` and `pipeline_stages`, so they only ever see pipeline-defined
 * rows — but the column types no longer say so. This module is the single,
 * narrow place where that is asserted, rather than sprinkling `!` across a
 * 5000-line service where nobody could later tell an assertion from a
 * transcription slip.
 *
 * It throws rather than coercing. A flow-defined case arriving on a pipeline
 * path is a routing bug, and a loud 422 naming the case is a far better
 * outcome than a `null` travelling one more layer.
 */
import { unprocessable } from "../errors.js";

type CaseShape = { id: string; pipelineId: string | null; stageId?: string | null };

export type PipelineDefinedCase<T extends CaseShape> = T & { pipelineId: string };

/** Narrow a case row known (by its query's joins) to be pipeline-defined. */
export function asPipelineDefinedCase<T extends CaseShape>(row: T): PipelineDefinedCase<T> {
  if (row.pipelineId === null) {
    throw unprocessable(
      `Case ${row.id} is not pipeline-defined (no pipeline_id) and cannot be used on a pipeline path.`,
      { code: "case_not_pipeline_defined", caseId: row.id },
    );
  }
  return row as PipelineDefinedCase<T>;
}

/** The pipeline id of a case row known to be pipeline-defined. */
export function pipelineIdOfCase(row: CaseShape): string {
  return asPipelineDefinedCase(row).pipelineId;
}
