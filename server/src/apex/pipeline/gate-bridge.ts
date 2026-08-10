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

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  approvals,
  documents,
  issueDocuments,
  issueRelations,
  issues,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  type Db,
} from "@paperclipai/db";
import { pipelineService, type PipelineActor } from "../../services/pipelines.js";
import { detectSpecDependenciesMismatch, parseSpecDependencies } from "./spec-dependencies.js";
import { logger } from "../../middleware/logger.js";

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
 * Load the spec document for the case (via case-issue link) and run the
 * dependency mismatch check. If `editedBody` is provided (the reviewer is
 * submitting a revised artifact), that body is checked instead of the stored
 * document — the human-visible version at approval time is authoritative.
 *
 * Returns an error string on mismatch, null when valid.
 */
async function loadSpecMismatch(
  db: Db,
  companyId: string,
  caseId: string,
  editedBody: string | null | undefined,
): Promise<string | null> {
  if (editedBody != null) {
    return detectSpecDependenciesMismatch(editedBody);
  }

  const link = await db
    .select({ issueId: pipelineCaseIssueLinks.issueId })
    .from(pipelineCaseIssueLinks)
    .where(and(eq(pipelineCaseIssueLinks.companyId, companyId), eq(pipelineCaseIssueLinks.caseId, caseId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!link) return null;

  const docRow = await db
    .select({ body: documents.latestBody })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(
      and(
        eq(issueDocuments.companyId, companyId),
        eq(issueDocuments.issueId, link.issueId),
        eq(issueDocuments.key, "spec"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!docRow?.body) return null;

  return detectSpecDependenciesMismatch(docRow.body);
}

/**
 * Resolve the issue id and declared dependency identifiers for a case's spec.
 * Returns null when there is no linked issue, no spec document, or no
 * declared dependencies.
 */
async function loadSpecDependencyContext(
  db: Db,
  companyId: string,
  caseId: string,
  editedBody?: string | null,
): Promise<{ issueId: string; identifiers: string[] } | null> {
  const link = await db
    .select({ issueId: pipelineCaseIssueLinks.issueId })
    .from(pipelineCaseIssueLinks)
    .where(
      and(
        eq(pipelineCaseIssueLinks.companyId, companyId),
        eq(pipelineCaseIssueLinks.caseId, caseId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!link) return null;

  let body = editedBody ?? null;
  if (body == null) {
    const docRow = await db
      .select({ body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(
        and(
          eq(issueDocuments.companyId, companyId),
          eq(issueDocuments.issueId, link.issueId),
          eq(issueDocuments.key, "spec"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    body = docRow?.body ?? null;
  }
  if (!body) return null;

  const identifiers = parseSpecDependencies(body);
  if (identifiers.length === 0) return null;
  return { issueId: link.issueId, identifiers };
}

/**
 * APEX-77 gate validation: every dependency the spec declares must be able to
 * become a real blocker edge. A declared dependency that cannot be written is
 * a FALSE ASSURANCE — the ticket would read as blocked while dispatch treats
 * it as runnable — so each failure mode below blocks gate approval rather than
 * being logged and dropped.
 *
 * Returns an operator-facing error string, or null when every declared
 * dependency is writable.
 */
export async function loadSpecDependencyValidationError(
  db: Db,
  companyId: string,
  caseId: string,
  editedBody?: string | null,
): Promise<string | null> {
  const ctx = await loadSpecDependencyContext(db, companyId, caseId, editedBody);
  if (!ctx) return null;
  const { issueId, identifiers } = ctx;

  const matchedRows = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.identifier, identifiers.map((id) => id.toUpperCase())),
      ),
    );
  const byIdentifier = new Map(
    matchedRows.map((r) => [r.identifier?.toUpperCase() ?? "", r.id]),
  );

  const unknown = identifiers.filter((ident) => !byIdentifier.has(ident.toUpperCase()));
  if (unknown.length > 0) {
    return (
      `Spec declares ${unknown.length === 1 ? "a dependency" : "dependencies"} that ` +
      `${unknown.length === 1 ? "does" : "do"} not exist in this company: ${unknown.join(", ")}. ` +
      `A declared blocker that cannot be resolved would leave this ticket looking blocked ` +
      `while dispatch treats it as runnable. Correct the identifier in the spec's ` +
      `\`dependencies\` front matter (and the ## Dependencies section) and approve again.`
    );
  }

  const selfRef = identifiers.filter((ident) => byIdentifier.get(ident.toUpperCase()) === issueId);
  if (selfRef.length > 0) {
    return (
      `Spec declares this ticket as its own dependency (${selfRef.join(", ")}). ` +
      `Remove it from the \`dependencies\` front matter and approve again.`
    );
  }

  const cycles: string[] = [];
  for (const ident of identifiers) {
    const blockerId = byIdentifier.get(ident.toUpperCase());
    if (!blockerId) continue;
    if (await wouldCreateCycle(db, companyId, blockerId, issueId)) cycles.push(ident);
  }
  if (cycles.length > 0) {
    return (
      `Spec declares ${cycles.length === 1 ? "a dependency" : "dependencies"} that would ` +
      `form a blocker cycle: ${cycles.join(", ")}. That edge cannot be written, so the ` +
      `dependency would silently not exist. Break the cycle — or drop the declaration — ` +
      `and approve again.`
    );
  }

  return null;
}

/**
 * Resolve and write blocker edges declared in the `dependencies` YAML front
 * matter field of the spec document for the issue that owns `caseId`.
 *
 * Called after a `spec_review` gate is approved. By that point
 * `loadSpecDependencyValidationError` has already rejected unknown
 * identifiers, self-references and cycle-forming edges, so anything that
 * still fails here is unexpected and THROWS rather than being swallowed — a
 * declared dependency must never silently fail to become an edge.
 *
 * Exported for integration testing.
 */
export async function writeSpecDependencyEdges(
  db: Db,
  companyId: string,
  caseId: string,
): Promise<void> {
  // Resolve caseId → issueId via the case-issue link table.
  const link = await db
    .select({ issueId: pipelineCaseIssueLinks.issueId })
    .from(pipelineCaseIssueLinks)
    .where(
      and(
        eq(pipelineCaseIssueLinks.companyId, companyId),
        eq(pipelineCaseIssueLinks.caseId, caseId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!link) return;
  const issueId = link.issueId;

  // Read the `spec` document for the issue.
  const docRow = await db
    .select({ body: documents.latestBody })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(
      and(
        eq(issueDocuments.companyId, companyId),
        eq(issueDocuments.issueId, issueId),
        eq(issueDocuments.key, "spec"),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!docRow?.body) return;

  const identifiers = parseSpecDependencies(docRow.body);
  if (identifiers.length === 0) return;

  // Resolve identifiers to same-company issue ids.
  const matchedRows = await db
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.identifier, identifiers.map((id) => id.toUpperCase())),
      ),
    );

  const knownIdentifiers = new Set(matchedRows.map((r) => r.identifier?.toUpperCase()));
  const unknown = identifiers.filter((ident) => !knownIdentifiers.has(ident.toUpperCase()));
  if (unknown.length > 0) {
    // Should be unreachable: the gate validator rejects these before approval.
    throw new Error(
      `spec-dependencies: declared dependencies do not resolve to issues (${unknown.join(", ")}) ` +
        `for issue ${issueId}; refusing to write a partial blocker set`,
    );
  }

  if (matchedRows.length === 0) return;

  // Fetch the current blocked-by set so we can merge rather than overwrite.
  const existing = await db
    .select({ blockerIssueId: issueRelations.issueId })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
      ),
    );
  const existingSet = new Set(existing.map((r) => r.blockerIssueId));

  const toAdd = matchedRows.filter((r) => !existingSet.has(r.id) && r.id !== issueId);
  if (toAdd.length === 0) return;

  // Write the edges. Every failure below is loud: a declared dependency that
  // does not become an edge is a false assurance, so we would rather fail the
  // write than leave the ticket looking blocked when it is not.
  for (const blocker of toAdd) {
    // Cycle-check: a simple DFS from the blocker — if it can reach issueId,
    // inserting this edge would form a cycle. The gate validator rejects these
    // before approval, so reaching here means the graph changed underneath us.
    const hasCycle = await wouldCreateCycle(db, companyId, blocker.id, issueId);
    if (hasCycle) {
      throw new Error(
        `spec-dependencies: declared dependency ${blocker.identifier ?? blocker.id} would form ` +
          `a blocker cycle with issue ${issueId}; refusing to write a partial blocker set`,
      );
    }
    try {
      await db.insert(issueRelations).values({
        companyId,
        issueId: blocker.id,
        relatedIssueId: issueId,
        type: "blocks",
      });
    } catch (err) {
      logger.error(
        { err, companyId, issueId, blockerId: blocker.id, identifier: blocker.identifier },
        "spec-dependencies: failed to insert declared blocker edge",
      );
      throw err;
    }
  }
}

/**
 * Returns true if inserting the edge `newBlockerId → dependentId` would create
 * a cycle (i.e., `dependentId` already blocks `newBlockerId` directly or
 * transitively).
 */
async function wouldCreateCycle(
  db: Db,
  companyId: string,
  newBlockerId: string,
  dependentId: string,
): Promise<boolean> {
  // BFS from dependentId through "blocks" edges; if we reach newBlockerId, there's a cycle.
  const visited = new Set<string>();
  const queue = [dependentId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === newBlockerId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const downstream = await db
      .select({ blockedId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .where(
        and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.issueId, current),
          eq(issueRelations.type, "blocks"),
        ),
      );
    for (const row of downstream) {
      if (!visited.has(row.blockedId)) queue.push(row.blockedId);
    }
  }
  return false;
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

  // APEX-77: for spec_review approvals, validate that the front matter
  // `dependencies` field and the ## Dependencies prose section agree before
  // the case transitions. A mismatch is a hard gate error — the reviewer must
  // fix the spec before re-approving.
  if (input.decision === "approve" && stage.stageKey === "spec_review") {
    const mismatch = await loadSpecMismatch(db, input.companyId, caseId, input.editedBody);
    if (mismatch) {
      return { transitioned: false, note: mismatch };
    }
    // Every declared dependency must be writable as a real blocker edge.
    const unwritable = await loadSpecDependencyValidationError(
      db,
      input.companyId,
      caseId,
      input.editedBody,
    );
    if (unwritable) {
      return { transitioned: false, note: unwritable };
    }
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

  // APEX-77: on spec_review approval, wire blocker edges from the spec's
  // `dependencies` front matter field. Run after the transition so the case is
  // past the gate even if edge-writing fails.
  if (input.decision === "approve" && stage.stageKey === "spec_review") {
    try {
      await writeSpecDependencyEdges(db, input.companyId, caseId);
    } catch (err) {
      logger.warn({ err, caseId, companyId: input.companyId }, "gate-bridge: spec-dependency edge write failed (non-fatal)");
    }
  }

  return { transitioned: true, toStageKey };
}
