/**
 * @deprecated GitHub-Issues → pipeline-cases ingestion adapter (apex-tower
 * migration — Task 2 §2c). Written back when the fork's `issues` table had
 * no GitHub linkage, so it mirrored open issues into the seeded lifecycle
 * pipeline as `pipelineCases` instead.
 *
 * SUPERSEDED by `./github-issue-ingest.ts` (work-loop doctrine Slice 0, see
 * docs/architecture/work-loop.md): the fork's `issues` table now has real
 * GitHub linkage (`originKind: "plugin:github"`, `originId`,
 * `originFingerprint`), so GitHub issues ingest directly into fork issues —
 * the statement-phase system of record per the doctrine's single-writer
 * table — not into a parallel pipeline-case shadow. New integrations should
 * use `runGithubIssueIngest` from `./github-issue-ingest.ts`.
 *
 * Left in place (not deleted) because `POST /apex/pipeline/ingest`
 * (routes/apex-pipeline.ts) still calls it for the spec-002 pipeline/cases
 * demo flow, which is a separate, still-live surface from the work-loop
 * Issues plane. Do not add new callers of this adapter.
 *
 * Idempotency: each issue's stable id (`owner/repo#N`) is used as the case
 * `caseKey`, so re-ingesting an already-mirrored issue upserts rather than
 * duplicating (the fork's `pipeline_cases_pipeline_case_key_uq` enforces this and
 * `ingestCase` returns `created:false` for the existing row).
 */

import type { Db } from "@paperclipai/db";
import { pipelineService, type PipelineActor } from "../../services/pipelines.js";
import type { TicketSource } from "./ticket-source.js";
import { GitHubIssuesSource } from "./ticket-source.js";
import type { Ticket } from "./types.js";

export interface IngestResult {
  ok: boolean;
  /** Non-null on success: the fork case id + whether it was newly created. */
  cases?: Array<{ caseId: string; caseKey: string; created: boolean; ticket: Ticket }>;
  /** Classified, human-actionable message when !ok (source unavailable etc.). */
  note?: string;
  source: string;
}

export class IssueIngestionAdapter {
  constructor(
    private readonly db: Db,
    private readonly source: TicketSource = new GitHubIssuesSource(),
  ) {}

  /**
   * Mirror every open issue in `repo` into `pipelineId` as a case on `ingested`.
   * Best-effort per issue: a single failed ingest is reported but does not abort
   * the batch. A source failure (gh missing/unauth) returns ok:false with a note.
   */
  async ingestRepo(input: {
    companyId: string;
    pipelineId: string;
    repo: string;
    actor?: PipelineActor;
  }): Promise<IngestResult> {
    const listed = await this.source.list(input.repo);
    if (!listed.ok) {
      return { ok: false, note: listed.message, source: listed.source };
    }

    const svc = pipelineService(this.db);
    const actor: PipelineActor = input.actor ?? { type: "system" };
    const cases: NonNullable<IngestResult["cases"]> = [];

    for (const ticket of listed.value) {
      const result = await svc.ingestCase({
        companyId: input.companyId,
        pipelineId: input.pipelineId,
        caseKey: ticket.id, // "owner/repo#N" — stable, dedupes on re-ingest.
        title: ticket.title,
        summary: ticket.body || null,
        stageKey: "ingested",
        fields: {
          source: ticket.source,
          repo: ticket.repo,
          issueNumber: ticket.number,
          issueUrl: ticket.url,
          issueStatus: ticket.status,
        },
        actor,
      });
      cases.push({
        caseId: result.case.id,
        caseKey: result.case.caseKey,
        created: result.created,
        ticket,
      });
    }

    return { ok: true, cases, source: listed.source };
  }
}
