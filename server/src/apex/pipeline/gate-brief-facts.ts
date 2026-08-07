/**
 * Gathering the records a gate's decision brief is assembled from.
 *
 * The split is deliberate and it is the whole point of this file existing
 * separately from ../steps/gate-brief.ts: EVERY sentence a reviewer reads is
 * assembled purely, from facts, by a synchronous function with no I/O. This
 * module is the only place that touches the database, and it decides NOTHING
 * about wording. Which means the interesting behaviour — an entry decision
 * with no earlier step, a step that finished and left nothing, a decision
 * re-entered after changes were asked for — is testable without a database,
 * and the assembly path cannot pick up a network dependency (or a model call)
 * by accident.
 *
 * NOTHING here is a new record. The upstream step, the document it wrote, the
 * verdict, the rounds already spent — all of it is already stored, and the
 * brief was hollow only because nobody read it back. That is why this change
 * needs no migration.
 *
 * Failure isolation, same doctrine as the flow brief this grew alongside:
 * every optional read degrades a section rather than failing the screen. A
 * reviewer with a partial brief can still decide; a reviewer with a 500
 * cannot.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  agents,
  approvals,
  documents,
  issueComments,
  issueDocuments,
  issues,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelines,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import type {
  GateBriefAcceptanceFacts,
  GateBriefDocument,
  GateBriefFacts,
  GateBriefPriorDecision,
  GateBriefRound,
  GateBriefTicketFacts,
  GateBriefUpstreamFacts,
} from "../steps/gate-brief.js";

/** How much of a document body travels with the brief.
 *
 *  Long enough that a spec's shape — its headings, its first task — is
 *  legible without leaving the page, short enough that the response is not a
 *  second copy of the repository. The whole document is always one click
 *  away, and `truncated` is carried so the UI SAYS it cut something rather
 *  than trailing off and letting the reader assume that was the end. */
const DOCUMENT_EXCERPT_CHARS = 1800;
/** A closing note is a paragraph, not a document. */
const NOTE_EXCERPT_CHARS = 900;

type StageRow = typeof pipelineStages.$inferSelect;

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function excerpt(body: string, max: number): { text: string; truncated: boolean } {
  const trimmedBody = body.trim();
  if (trimmedBody.length <= max) return { text: trimmedBody, truncated: false };
  // Cut on a line boundary when there is one nearby, so an excerpt ends on a
  // sentence rather than mid-word.
  const slice = trimmedBody.slice(0, max);
  const lastBreak = slice.lastIndexOf("\n");
  const cut = lastBreak > max * 0.6 ? slice.slice(0, lastBreak) : slice;
  return { text: cut.trimEnd(), truncated: true };
}

function stageConfigOf(stage: StageRow): Record<string, unknown> {
  const config = stage.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return {};
  return config as Record<string, unknown>;
}

/**
 * Which of the three step kinds a stage IS, or null when it executes nothing.
 *
 * The same boundary `pipelineProcessDefinition` draws, and drawn the same way:
 * a `working` column with no entry step is a waiting position where a person
 * does the work and moves the card. It is not the "previous step", and
 * narrating it as one would put "the last step produced nothing" on a brief
 * about a column that was never going to produce anything.
 */
function stepKindOf(stage: StageRow): "run" | "agent" | "gate" | null {
  if (stage.kind === "review") return "gate";
  const onEnter = stageConfigOf(stage).onEnter as { type?: string } | undefined;
  if (!onEnter || typeof onEnter !== "object") return null;
  if (onEnter.type === "run") return "run";
  if (onEnter.type === "agent" || onEnter.type === "routine") return "agent";
  return null;
}

/** What a `run` step invokes, named so the reader knows what produced the
 *  state they are approving. Null for anything else. */
function ranWhatOf(stage: StageRow): string | null {
  const onEnter = stageConfigOf(stage).onEnter as
    | { type?: string; target?: { type?: string; workflow?: string; tool?: string } }
    | undefined;
  if (!onEnter || onEnter.type !== "run") return null;
  const target = onEnter.target;
  if (!target) return null;
  return trimmed(target.workflow) ?? trimmed(target.tool);
}

/** The `## Acceptance Criteria` section of a ticket body, when it has one. */
export function acceptanceSectionOf(description: string | null): string | null {
  if (!description) return null;
  const re = /^##+\s+acceptance(?:\s+criteria)?\s*$([\s\S]*?)(?=^##+\s+|(?![\s\S]))/im;
  const section = re.exec(description)?.[1]?.trim();
  return section && section.length > 0 ? section : null;
}

/** `https://github.com/owner/repo.git` → `owner/repo`; a local path stays as
 *  it is. A person recognises the repository, not the clone URL. */
function describeCodebase(repoUrl: string | null, cwd: string | null): string | null {
  const url = trimmed(repoUrl);
  if (url) {
    const match = /(?:[:/])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
    return match?.[1] ?? url;
  }
  return trimmed(cwd);
}

/** `pr_exists:<repo>#<head>` — the only acceptance grammar that names an
 *  artifact living outside the cockpit. Parsed defensively; anything else
 *  simply yields no pull-request link. */
function pullRequestFromAcceptance(
  criteria: string | null,
): { repo: string; head: string } | null {
  const match = /^pr_exists:\s*([^\s#]+)#(\S+)$/i.exec((criteria ?? "").trim());
  if (!match) return null;
  return { repo: match[1]!, head: match[2]! };
}

/** The PR URL out of the recorded verdict text, when the evaluator captured
 *  one. Never fabricated — a missing URL means the brief links the repo and
 *  branch instead of guessing a number. */
function pullRequestUrlFromEvaluation(evaluation: string | null): string | null {
  const match = /(https:\/\/github\.com\/\S+?\/pull\/\d+)/.exec(evaluation ?? "");
  return match?.[1] ?? null;
}

/**
 * The OPEN decision on each of these pieces of work, by id.
 *
 * Both surfaces that show a gate — the ticket and the item page — need this
 * for the same reason: the brief is served by approval id, and neither
 * surface knew one. They read it through this function rather than each
 * writing the query, because "which approval is this decision" answered two
 * ways is how the ticket and the item page start showing two different
 * briefs for one decision.
 *
 * Both spellings a gate approval has ever had are matched (`flow_gate` from a
 * stage gate, `pipeline_gate` from the review-stage bridge) — a decision is a
 * decision regardless of which opened it.
 */
export async function openGateApprovalIdsForCases(
  db: Db,
  companyId: string,
  caseIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (caseIds.length === 0) return out;
  const rows = await db
    .select({ id: approvals.id, payload: approvals.payload, createdAt: approvals.createdAt })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        inArray(approvals.type, ["flow_gate", "pipeline_gate"]),
        or(eq(approvals.status, "pending"), eq(approvals.status, "revision_requested")),
        inArray(sql`${approvals.payload} ->> 'caseId'`, caseIds),
      ),
    )
    .orderBy(asc(approvals.createdAt));
  for (const row of rows) {
    const caseId = trimmed((row.payload as Record<string, unknown> | null)?.caseId);
    // Newest wins: a re-opened decision supersedes one left pending by an
    // earlier visit to the same step.
    if (caseId) out.set(caseId, row.id);
  }
  return out;
}

export type GateBriefFactsInput = {
  approvalId: string;
  companyId: string;
  caseId: string;
  /** The stage the decision is being taken at. Read from the approval payload
   *  rather than from the case, so a brief for an approval whose case has
   *  since moved describes the decision that was actually opened. */
  stepKey: string | null;
  /** Injected so "waiting 3 hours" is deterministic under test. */
  now?: Date;
};

/**
 * Read everything a gate brief needs. Returns null only when the work itself
 * cannot be found — every other gap is expressed as an absent fact, which the
 * assembler then states plainly.
 */
export async function loadGateBriefFacts(
  db: Db,
  input: GateBriefFactsInput,
): Promise<GateBriefFacts | null> {
  const now = input.now ?? new Date();
  const row = await db
    .select({ caseRow: pipelineCases, pipeline: pipelines })
    .from(pipelineCases)
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .where(and(eq(pipelineCases.companyId, input.companyId), eq(pipelineCases.id, input.caseId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return null;

  const stages = await db
    .select()
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, row.caseRow.pipelineId))
    .orderBy(asc(pipelineStages.position));
  const stageByKey = new Map(stages.map((stage) => [stage.key, stage]));
  const decisionStage =
    (input.stepKey ? stageByKey.get(input.stepKey) : null) ??
    stages.find((stage) => stage.id === row.caseRow.stageId) ??
    null;
  if (!decisionStage) return null;

  const config = stageConfigOf(decisionStage);
  const gate = (config.gate ?? {}) as { prompt?: unknown; requires?: unknown };
  const nameOf = (key: unknown): string | null =>
    typeof key === "string" ? stageByKey.get(key)?.name ?? key : null;

  // The step immediately BEFORE this decision, among the stages that actually
  // execute something. Null when this decision is the first thing the process
  // does — the Feature lifecycle's Promote, and a designed case downstream.
  const executing = stages.filter((stage) => stepKindOf(stage) !== null);
  const decisionIndex = executing.findIndex((stage) => stage.id === decisionStage.id);
  const upstreamStage = decisionIndex > 0 ? executing[decisionIndex - 1]! : null;

  const [ticket, gateOpenedAt] = await Promise.all([
    loadTicketFacts(db, input.companyId, input.caseId),
    readGateOpenedAt(db, input.companyId, input.caseId, decisionStage.id),
  ]);

  const [upstream, acceptance, rounds, priorDecisions] = await Promise.all([
    upstreamStage
      ? loadUpstreamFacts(db, {
          companyId: input.companyId,
          caseId: input.caseId,
          stage: upstreamStage,
          issueId: ticket?.id ?? null,
        })
      : Promise.resolve(null),
    upstreamStage
      ? loadAcceptanceFacts(db, {
          companyId: input.companyId,
          caseId: input.caseId,
          stage: upstreamStage,
          workVersion: row.caseRow.version,
        })
      : Promise.resolve(null),
    loadRounds(db, input.companyId, input.caseId, decisionStage.id),
    loadPriorDecisions(db, input.companyId, input.caseId, decisionStage.id, stageByKey),
  ]);

  // A pull request the upstream step was required to open is declared by the
  // acceptance contract, not by the step — so it is stitched on here rather
  // than read twice.
  if (upstream && acceptance) {
    const target = pullRequestFromAcceptance(acceptance.criteria);
    if (target) {
      upstream.pullRequest = {
        ...target,
        url: pullRequestUrlFromEvaluation(acceptance.evaluation),
      };
    }
  }

  return {
    approvalId: input.approvalId,
    caseId: input.caseId,
    workVersion: row.caseRow.version,
    pipeline: { key: row.pipeline.key, name: row.pipeline.name },
    decision: {
      stepKey: decisionStage.key,
      stepName: decisionStage.name,
      question: trimmed(gate.prompt),
      reviewPassIds: Array.isArray(gate.requires)
        ? gate.requires.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [],
      approveToStepName: nameOf(config.approveToStageKey),
      rejectToStepName: nameOf(config.rejectToStageKey),
      requestChangesToStepName: nameOf(config.requestChangesToStageKey),
      openedAt: gateOpenedAt,
    },
    ticket,
    upstream,
    acceptance,
    rounds,
    priorDecisions,
    now: now.toISOString(),
  };
}

/**
 * The ticket behind the work — its own words, and the two facts that decide
 * whether it can even start (what kind of work it is, which codebase it lands
 * in). Read for every brief, not just entry decisions: the title is the
 * subject line of every one of them.
 */
async function loadTicketFacts(
  db: Db,
  companyId: string,
  caseId: string,
): Promise<GateBriefTicketFacts | null> {
  const link = await db
    .select({ issueId: pipelineCaseIssueLinks.issueId })
    .from(pipelineCaseIssueLinks)
    .where(and(eq(pipelineCaseIssueLinks.caseId, caseId), isNull(pipelineCaseIssueLinks.retiredAt)))
    .orderBy(desc(pipelineCaseIssueLinks.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!link) return null;

  const issue = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      description: issues.description,
      ticketType: issues.ticketType,
      repoUrl: projectWorkspaces.repoUrl,
      cwd: projectWorkspaces.cwd,
    })
    .from(issues)
    .leftJoin(projectWorkspaces, eq(issues.projectWorkspaceId, projectWorkspaces.id))
    .where(and(eq(issues.companyId, companyId), eq(issues.id, link.issueId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!issue) return null;

  return {
    id: issue.id,
    identifier: trimmed(issue.identifier),
    title: issue.title,
    description: trimmed(issue.description),
    acceptanceSection: acceptanceSectionOf(issue.description),
    ticketType: trimmed(issue.ticketType),
    codebase: describeCodebase(issue.repoUrl, issue.cwd),
  };
}

/** When this decision started waiting for a person. */
async function readGateOpenedAt(
  db: Db,
  companyId: string,
  caseId: string,
  stageId: string,
): Promise<string | null> {
  const row = await db
    .select({ createdAt: pipelineCaseEvents.createdAt })
    .from(pipelineCaseEvents)
    .where(
      and(
        eq(pipelineCaseEvents.companyId, companyId),
        eq(pipelineCaseEvents.caseId, caseId),
        eq(pipelineCaseEvents.type, "gate_opened"),
        sql`${pipelineCaseEvents.payload} ->> 'stageId' = ${stageId}`,
      ),
    )
    .orderBy(desc(pipelineCaseEvents.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return iso(row?.createdAt ?? null);
}

/**
 * What the step before this decision did, and what it left behind.
 *
 * Three places an upstream step can leave something, and all three are read
 * because different steps use different ones: a specifier writes a DOCUMENT,
 * an implementer opens a CHANGE, and any agent run can leave a closing NOTE
 * on the conversation. Finding none of the three is itself the answer, and
 * the assembler says so.
 */
async function loadUpstreamFacts(
  db: Db,
  input: { companyId: string; caseId: string; stage: StageRow; issueId: string | null },
): Promise<GateBriefUpstreamFacts> {
  const kind = stepKindOf(input.stage) ?? "run";
  const facts: GateBriefUpstreamFacts = {
    stepKey: input.stage.key,
    stepName: input.stage.name,
    kind,
    actorName: null,
    finishedAt: null,
    documents: [],
    pullRequest: null,
    closingNote: null,
    ranWhat: ranWhatOf(input.stage),
  };

  const [waiting, finished] = await Promise.all([
    db
      .select({ payload: pipelineCaseEvents.payload })
      .from(pipelineCaseEvents)
      .where(
        and(
          eq(pipelineCaseEvents.companyId, input.companyId),
          eq(pipelineCaseEvents.caseId, input.caseId),
          eq(pipelineCaseEvents.type, "step_waiting"),
          sql`${pipelineCaseEvents.payload} ->> 'stageId' = ${input.stage.id}`,
        ),
      )
      .orderBy(desc(pipelineCaseEvents.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ createdAt: pipelineCaseEvents.createdAt })
      .from(pipelineCaseEvents)
      .where(
        and(
          eq(pipelineCaseEvents.companyId, input.companyId),
          eq(pipelineCaseEvents.caseId, input.caseId),
          inArray(pipelineCaseEvents.type, ["step_resumed", "automation_executed"]),
          sql`${pipelineCaseEvents.payload} ->> 'stageId' = ${input.stage.id}`,
        ),
      )
      .orderBy(desc(pipelineCaseEvents.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  facts.finishedAt = iso(finished?.createdAt ?? null);

  const agentId = trimmed((waiting?.payload as Record<string, unknown> | undefined)?.agentId);
  if (agentId) {
    const agent = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    facts.actorName = trimmed(agent?.name);
  }

  if (input.issueId) {
    const [docs, note] = await Promise.all([
      loadUpstreamDocuments(db, input.companyId, input.issueId),
      loadClosingNote(db, input.companyId, input.issueId, agentId),
    ]);
    facts.documents = docs;
    facts.closingNote = note;
  }
  return facts;
}

/**
 * The documents the work has produced, newest first.
 *
 * Filtered to the keys a person is meant to REVIEW (`spec`, `plan`, and
 * anything an agent named itself) — the system-authored bookkeeping documents
 * are not artifacts, and putting a continuation summary in front of a
 * reviewer as "what the last step produced" would be exactly the agent slop
 * this brief exists to clear away.
 */
async function loadUpstreamDocuments(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<GateBriefDocument[]> {
  const { isSystemIssueDocumentKey } = await import("@paperclipai/shared");
  const rows = await db
    .select({
      key: issueDocuments.key,
      title: documents.title,
      body: documents.latestBody,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId)))
    .orderBy(desc(documents.updatedAt))
    .limit(4);
  return rows
    .filter((row) => !isSystemIssueDocumentKey(row.key))
    .map((row) => {
      const cut = excerpt(row.body ?? "", DOCUMENT_EXCERPT_CHARS);
      return {
        key: row.key,
        title: trimmed(row.title),
        excerpt: cut.text,
        truncated: cut.truncated,
        updatedAt: iso(row.updatedAt),
      };
    })
    .filter((doc) => doc.excerpt.length > 0);
}

/** The last thing the executing agent said on the conversation. */
async function loadClosingNote(
  db: Db,
  companyId: string,
  issueId: string,
  agentId: string | null,
): Promise<GateBriefUpstreamFacts["closingNote"]> {
  if (!agentId) return null;
  const row = await db
    .select({ body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, issueId),
        eq(issueComments.authorAgentId, agentId),
        isNull(issueComments.deletedAt),
      ),
    )
    .orderBy(desc(issueComments.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row?.body?.trim()) return null;
  const cut = excerpt(row.body, NOTE_EXCERPT_CHARS);
  return { excerpt: cut.text, truncated: cut.truncated, at: iso(row.createdAt) };
}

/**
 * The server's own verdict on the upstream step, and whether it still covers
 * the work on screen.
 *
 * `evaluatedCaseVersion` is compared against the CURRENT version rather than
 * assumed current, because that comparison is the whole difference between
 * "this was checked" and "something that used to be here was checked".
 */
async function loadAcceptanceFacts(
  db: Db,
  input: { companyId: string; caseId: string; stage: StageRow; workVersion: number },
): Promise<GateBriefAcceptanceFacts | null> {
  const row = await db
    .select({ payload: pipelineCaseEvents.payload, createdAt: pipelineCaseEvents.createdAt })
    .from(pipelineCaseEvents)
    .where(
      and(
        eq(pipelineCaseEvents.companyId, input.companyId),
        eq(pipelineCaseEvents.caseId, input.caseId),
        eq(pipelineCaseEvents.type, "acceptance_evaluated"),
        sql`${pipelineCaseEvents.payload} ->> 'stageId' = ${input.stage.id}`,
      ),
    )
    .orderBy(desc(pipelineCaseEvents.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const criteria = trimmed(payload.criteria);
  if (!criteria) return null;
  return {
    criteria,
    ok: payload.ok === true,
    message: trimmed(payload.message),
    evaluation: trimmed(payload.evaluation),
    coversCurrentWork:
      typeof payload.evaluatedCaseVersion === "number"
        ? payload.evaluatedCaseVersion === input.workVersion
        : false,
    evaluatedAt: iso(row.createdAt),
  };
}

/**
 * Rounds already spent at THIS decision.
 *
 * Keyed on `fromStageId` — the decision the reviewer was standing at when
 * they sent it back — rather than on where it was sent to. A gate that has
 * already asked for changes twice is a different decision from a fresh one,
 * and the reviewer must be able to check the new work against what they asked
 * for last time instead of re-reading it cold.
 */
async function loadRounds(
  db: Db,
  companyId: string,
  caseId: string,
  stageId: string,
): Promise<GateBriefRound[]> {
  const rows = await db
    .select({ payload: pipelineCaseEvents.payload, createdAt: pipelineCaseEvents.createdAt })
    .from(pipelineCaseEvents)
    .where(
      and(
        eq(pipelineCaseEvents.companyId, companyId),
        eq(pipelineCaseEvents.caseId, caseId),
        eq(pipelineCaseEvents.type, "review_decided"),
        eq(pipelineCaseEvents.fromStageId, stageId),
        sql`${pipelineCaseEvents.payload} ->> 'decision' = 'request_changes'`,
      ),
    )
    .orderBy(asc(pipelineCaseEvents.createdAt));
  return rows.map((row, index) => ({
    round: index + 1,
    askedFor: trimmed((row.payload as Record<string, unknown> | null)?.reason),
    at: iso(row.createdAt),
  }));
}

/** Decisions already taken at OTHER points on this work — which parts are
 *  settled, and by whom. Newest three; a fourth is history, not context. */
async function loadPriorDecisions(
  db: Db,
  companyId: string,
  caseId: string,
  currentStageId: string,
  stageByKey: Map<string, StageRow>,
): Promise<GateBriefPriorDecision[]> {
  const stageById = new Map([...stageByKey.values()].map((stage) => [stage.id, stage]));
  const rows = await db
    .select({
      payload: pipelineCaseEvents.payload,
      fromStageId: pipelineCaseEvents.fromStageId,
      createdAt: pipelineCaseEvents.createdAt,
    })
    .from(pipelineCaseEvents)
    .where(
      and(
        eq(pipelineCaseEvents.companyId, companyId),
        eq(pipelineCaseEvents.caseId, caseId),
        eq(pipelineCaseEvents.type, "review_decided"),
      ),
    )
    .orderBy(desc(pipelineCaseEvents.createdAt))
    .limit(8);
  const out: GateBriefPriorDecision[] = [];
  for (const row of rows) {
    if (row.fromStageId === currentStageId) continue;
    const decision = trimmed((row.payload as Record<string, unknown> | null)?.decision);
    if (decision !== "approve" && decision !== "reject" && decision !== "request_changes") continue;
    const stage = row.fromStageId ? stageById.get(row.fromStageId) : null;
    if (!stage) continue;
    out.push({ stepName: stage.name, decision, at: iso(row.createdAt) });
    if (out.length >= 3) break;
  }
  return out;
}
