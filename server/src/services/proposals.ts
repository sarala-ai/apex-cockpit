/**
 * PROPOSALS — storage, the single gate, and materialisation.
 *
 * The review model in one sentence: an agent proposes typed records, a person
 * corrects them ON THE PROPOSAL, one approval decides the whole set, and only
 * that approval writes to the board.
 *
 * Materialisation is a REGISTRY, not a switch. A kind registers how its records
 * become objects, and neither the routes nor the review surface learn its name
 * — the same seam the artifact-renderer registry established for gate
 * rendering. Exactly one kind ships (`initiatives`), which is what proves the
 * seam; a second kind built before the first has a reviewer would be a guess.
 */
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, goals, proposals } from "@paperclipai/db";
import {
  PROPOSAL_APPROVAL_TYPE,
  getProposalKind,
  initiativeProposalFieldsSchema,
  isProposalEditable,
  validateProposalRecordFields,
  type ProposalRecord,
} from "@paperclipai/shared";

export type MaterializationResult = {
  created: string[];
  updated: string[];
  skipped: string[];
  errors: Array<{ ref: string; error: string }>;
};

export type MaterializeContext = {
  db: Db;
  companyId: string;
  proposalId: string;
};

/** How one kind's records become objects on the board. */
export type ProposalMaterializer = {
  kind: string;
  materialize: (
    context: MaterializeContext,
    records: readonly ProposalRecord[],
  ) => Promise<MaterializationResult>;
};

const materializers = new Map<string, ProposalMaterializer>();

export function registerProposalMaterializer(materializer: ProposalMaterializer): void {
  materializers.set(materializer.kind, materializer);
}

export function getProposalMaterializer(kind: string): ProposalMaterializer | null {
  return materializers.get(kind) ?? null;
}

function emptyResult(): MaterializationResult {
  return { created: [], updated: [], skipped: [], errors: [] };
}

/**
 * The `initiatives` materialiser.
 *
 * `targetId` present → UPDATE that initiative. Absent → CREATE one. Update is
 * not an afterthought: the job this was built for is correcting ~26
 * initiatives that already exist on a live board, so a create-only
 * materialiser would be useless for its own first user.
 *
 * `status` is never written. An initiative's status is derived from its
 * projects, and a proposal that could set it would create the second competing
 * answer the derived reading exists to prevent.
 */
export const initiativesMaterializer: ProposalMaterializer = {
  kind: "initiatives",
  materialize: async ({ db, companyId }, records) => {
    const result = emptyResult();

    for (const record of records) {
      if (record.excluded) {
        result.skipped.push(record.ref);
        continue;
      }

      const parsed = initiativeProposalFieldsSchema.safeParse(record.fields);
      if (!parsed.success) {
        result.errors.push({
          ref: record.ref,
          error: parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "fields"}: ${issue.message}`)
            .join("; "),
        });
        continue;
      }

      const fields = parsed.data;
      const values = {
        title: fields.title,
        description: fields.description ?? null,
        hypothesis: fields.hypothesis ?? null,
        budget: fields.budget ?? null,
        // Written through exactly as proposed, never defaulted. An initiative
        // with no stop condition is an honest record that nobody wrote one.
        stopCondition: fields.stopCondition ?? null,
        closure: fields.closure ?? null,
        closureReason: fields.closureReason ?? null,
        provenance: {
          kind: record.provenance.kind,
          source: record.provenance.source ?? null,
        },
      };

      if (record.targetId) {
        // Scoped to the company on the UPDATE itself, not on a prior read: a
        // proposal must never reach an initiative in another company even if
        // its target id was tampered with between review and approval.
        const [updated] = await db
          .update(goals)
          .set({ ...values, updatedAt: new Date() })
          .where(
            and(
              eq(goals.id, record.targetId),
              eq(goals.companyId, companyId),
              eq(goals.level, "initiative"),
            ),
          )
          .returning({ id: goals.id });
        if (!updated) {
          result.errors.push({
            ref: record.ref,
            error: `No initiative ${record.targetId} in this company — nothing was updated.`,
          });
          continue;
        }
        result.updated.push(updated.id);
        continue;
      }

      const [created] = await db
        .insert(goals)
        .values({ ...values, companyId, level: "initiative" })
        .returning({ id: goals.id });
      result.created.push(created.id);
    }

    return result;
  },
};

registerProposalMaterializer(initiativesMaterializer);

export function proposalService(db: Db) {
  const service = {
    list: (companyId: string) =>
      db
        .select()
        .from(proposals)
        .where(eq(proposals.companyId, companyId))
        .orderBy(asc(proposals.createdAt)),

    getById: (id: string) =>
      db
        .select()
        .from(proposals)
        .where(eq(proposals.id, id))
        .then((rows) => rows[0] ?? null),

    getByApprovalId: (approvalId: string) =>
      db
        .select()
        .from(proposals)
        .where(eq(proposals.approvalId, approvalId))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof proposals.$inferInsert, "companyId">) =>
      db
        .insert(proposals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    update: (id: string, data: Partial<typeof proposals.$inferInsert>) =>
      db
        .update(proposals)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(proposals.id, id))
        .returning()
        .then((rows) => rows[0] ?? null),

    /**
     * Apply one reviewer correction. `fields` MERGES: correcting one cell must
     * never require resending the other nine, and a full-object PUT here would
     * make a two-word fix a chance to clobber the row.
     */
    correctRecord: async (
      id: string,
      ref: string,
      patch: {
        fields?: Record<string, unknown>;
        note?: string | null;
        excluded?: boolean;
        provenance?: { kind: "confirmed" | "inferred"; source?: string | null } | null;
      },
      correctedByUserId: string,
    ) => {
      const existing = await service.getById(id);
      if (!existing) return { error: "not_found" as const };
      if (!isProposalEditable(existing.status)) {
        return { error: "closed" as const };
      }
      const records = (existing.records ?? []) as ProposalRecord[];
      const index = records.findIndex((record) => record.ref === ref);
      if (index === -1) return { error: "no_record" as const };

      const current = records[index];
      const next: ProposalRecord = {
        ...current,
        fields: patch.fields ? { ...current.fields, ...patch.fields } : current.fields,
        note: patch.note === undefined ? current.note ?? null : patch.note,
        excluded: patch.excluded === undefined ? current.excluded ?? false : patch.excluded,
        provenance: patch.provenance ?? current.provenance,
        correctedAt: new Date().toISOString(),
        correctedByUserId,
      };

      // Validation is advisory here, not blocking: a half-corrected row must
      // stay saveable so the reviewer can come back to it. The gate is where
      // an invalid record is stopped.
      const fieldsError = validateProposalRecordFields(existing.kind, next.fields);

      const updatedRows = [...records];
      updatedRows[index] = next;
      const updated = await service.update(id, { records: updatedRows });
      return { proposal: updated, record: next, fieldsError };
    },

    /**
     * Open the single gate. One approval for the whole set — the decision this
     * object exists to make is "is this reconstruction right", not "is row 14
     * right".
     */
    submit: async (id: string, note: string | null) => {
      const existing = await service.getById(id);
      if (!existing) return { error: "not_found" as const };
      if (existing.status === "approved") return { error: "closed" as const };

      const records = (existing.records ?? []) as ProposalRecord[];
      const live = records.filter((record) => !record.excluded);
      const [approval] = await db
        .insert(approvals)
        .values({
          companyId: existing.companyId,
          type: PROPOSAL_APPROVAL_TYPE,
          status: "pending",
          requestedByAgentId: existing.proposedByAgentId ?? null,
          requestedByUserId: existing.proposedByUserId ?? null,
          payload: {
            proposalId: existing.id,
            kind: existing.kind,
            title: existing.title,
            recordCount: live.length,
            excludedCount: records.length - live.length,
            createCount: live.filter((record) => !record.targetId).length,
            updateCount: live.filter((record) => record.targetId).length,
            inferredCount: live.filter((record) => record.provenance.kind === "inferred").length,
            note,
          },
        })
        .returning();

      const updated = await service.update(id, {
        status: "in_review",
        approvalId: approval.id,
      });
      return { proposal: updated, approval };
    },

    /**
     * The gate decision landing. Approve MATERIALISES; request-changes and
     * reject only move the proposal, because the reasons and the routing back
     * to the proposing agent are the approval's job and already exist.
     */
    onApprovalDecision: async (
      approvalId: string,
      decision: "approve" | "request_changes" | "reject",
    ) => {
      const proposal = await service.getByApprovalId(approvalId);
      if (!proposal) return null;

      if (decision === "request_changes") {
        return service.update(proposal.id, { status: "changes_requested" });
      }
      if (decision === "reject") {
        return service.update(proposal.id, { status: "rejected" });
      }

      const materializer = getProposalMaterializer(proposal.kind);
      if (!materializer) {
        // An approved proposal whose kind has no materialiser is a deployment
        // error, not a reviewer error. Record it on the proposal rather than
        // failing the decision the person already made.
        return service.update(proposal.id, {
          status: "approved",
          materializedAt: new Date(),
          materialization: {
            created: [],
            updated: [],
            skipped: [],
            errors: [
              {
                ref: "*",
                error: `No materializer registered for proposal kind "${proposal.kind}" — nothing was written.`,
              },
            ],
          },
        });
      }

      const result = await materializer.materialize(
        { db, companyId: proposal.companyId, proposalId: proposal.id },
        (proposal.records ?? []) as ProposalRecord[],
      );

      return service.update(proposal.id, {
        status: "approved",
        materializedAt: new Date(),
        materialization: result,
      });
    },

    /** Which columns the kind declares — served so the UI never hardcodes them. */
    kindDefinition: (kind: string) => getProposalKind(kind),
  };

  return service;
}
