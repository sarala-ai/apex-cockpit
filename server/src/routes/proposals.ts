/**
 * PROPOSAL routes — the review surface's API.
 *
 * The shape of the thing: a proposal is assembled (POST), corrected in place by
 * a reviewer (PATCH one record), submitted to ONE gate (POST /submit), and then
 * the approval decides. Approval materialises; request-changes and reject route
 * back through the approval machinery that already exists.
 *
 * Nothing here knows what an initiative is. The kind's schema validates its
 * records and the kind's materialiser writes them, so a second kind is a
 * registration, not an edit to this file.
 */
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  correctProposalRecordSchema,
  createProposalSchema,
  getProposalKind,
  listProposalKinds,
  submitProposalSchema,
  updateProposalSchema,
  validateProposalRecordFields,
  type ProposalRecord,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity, proposalService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { buildProposalCsv } from "../services/goal-csv.js";

export function proposalRoutes(db: Db) {
  const router = Router();
  const svc = proposalService(db);

  /** The registered kinds and their columns. The UI renders from this, not from
   *  a hardcoded column list, which is what keeps the grid kind-agnostic. */
  router.get("/proposal-kinds", (_req, res) => {
    res.json(
      listProposalKinds().map((definition) => ({
        kind: definition.kind,
        label: definition.label,
        columns: definition.columns,
      })),
    );
  });

  router.get("/companies/:companyId/proposals", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.list(companyId));
  });

  router.get("/proposals/:id", async (req, res) => {
    const proposal = await svc.getById(req.params.id as string);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertCompanyAccess(req, proposal.companyId);
    res.json(proposal);
  });

  /**
   * A proposal exported for offline scanning. The CSV round-trip that started
   * this work survives here as what it always actually was — a way to read a
   * lot of rows at once — with the review itself now living on the proposal.
   */
  router.get("/proposals/:id/export.csv", async (req, res) => {
    const proposal = await svc.getById(req.params.id as string);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertCompanyAccess(req, proposal.companyId);
    const csv = buildProposalCsv(
      (proposal.records ?? []) as ProposalRecord[],
      getProposalKind(proposal.kind)?.columns ?? [],
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="proposal-${proposal.id}.csv"`);
    res.send(csv);
  });

  router.post(
    "/companies/:companyId/proposals",
    validate(createProposalSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      if (!getProposalKind(req.body.kind)) {
        res.status(400).json({ error: `Unknown proposal kind "${req.body.kind}".` });
        return;
      }

      const records = (req.body.records ?? []) as ProposalRecord[];
      const refs = new Set<string>();
      for (const record of records) {
        if (refs.has(record.ref)) {
          res.status(400).json({
            error: `Duplicate record ref "${record.ref}" — refs address corrections and must be unique.`,
          });
          return;
        }
        refs.add(record.ref);
      }

      const actor = getActorInfo(req);
      const proposal = await svc.create(companyId, {
        kind: req.body.kind,
        title: req.body.title,
        summary: req.body.summary ?? null,
        records,
        proposedByAgentId: req.body.proposedByAgentId ?? actor.agentId ?? null,
        proposedByUserId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "proposal.created",
        entityType: "proposal",
        entityId: proposal.id,
        details: { kind: proposal.kind, title: proposal.title, recordCount: records.length },
      });

      res.status(201).json(proposal);
    },
  );

  router.patch("/proposals/:id", validate(updateProposalSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    if (existing.status === "approved") {
      res.status(400).json({
        error: "An approved proposal is a record of what was materialised and cannot be edited.",
      });
      return;
    }
    const proposal = await svc.update(existing.id, req.body);
    res.json(proposal);
  });

  /**
   * ONE ROW, CORRECTED IN PLACE. This is the verb the whole surface is built
   * around: a reviewer scanning a grid fixes a cell, leaves a note, or strikes
   * a row out — and none of it touches a live object.
   */
  router.patch(
    "/proposals/:id/records/:ref",
    validate(correctProposalRecordSchema),
    async (req, res) => {
      assertBoard(req);
      const existing = await svc.getById(req.params.id as string);
      if (!existing) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);

      const actor = getActorInfo(req);
      const outcome = await svc.correctRecord(
        existing.id,
        req.params.ref as string,
        req.body,
        actor.actorId ?? "board",
      );

      if (outcome.error === "not_found") {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }
      if (outcome.error === "no_record") {
        res.status(404).json({ error: `No record "${req.params.ref}" on this proposal` });
        return;
      }
      if (outcome.error === "closed") {
        res.status(400).json({
          error: "This proposal has been decided; its records are a record of what was reviewed.",
        });
        return;
      }

      await logActivity(db, {
        companyId: existing.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        action: "proposal.record_corrected",
        entityType: "proposal",
        entityId: existing.id,
        details: {
          ref: req.params.ref,
          fields: Object.keys(req.body.fields ?? {}),
          excluded: outcome.record?.excluded ?? false,
        },
      });

      res.json({
        proposal: outcome.proposal,
        record: outcome.record,
        // Advisory: a half-corrected row stays saveable, and the gate is where
        // an invalid record is actually stopped.
        fieldsError: outcome.fieldsError ?? null,
      });
    },
  );

  /** Open the single gate over the whole set. */
  router.post("/proposals/:id/submit", validate(submitProposalSchema), async (req, res) => {
    const existing = await svc.getById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const live = ((existing.records ?? []) as ProposalRecord[]).filter(
      (record) => !record.excluded,
    );
    if (live.length === 0) {
      res.status(400).json({
        error: "Nothing to review: every record on this proposal is excluded.",
      });
      return;
    }
    const invalid = live
      .map((record) => ({
        ref: record.ref,
        error: validateProposalRecordFields(existing.kind, record.fields),
      }))
      .filter((entry) => entry.error);
    if (invalid.length > 0) {
      res.status(400).json({
        error: "Some records do not match this kind's shape; correct or exclude them first.",
        invalid,
      });
      return;
    }

    const outcome = await svc.submit(existing.id, req.body.note ?? null);
    if (outcome.error === "not_found") {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    if (outcome.error === "closed") {
      res.status(400).json({ error: "This proposal has already been approved." });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      action: "proposal.submitted",
      entityType: "proposal",
      entityId: existing.id,
      details: { approvalId: outcome.approval?.id ?? null, recordCount: live.length },
    });

    res.status(201).json({ proposal: outcome.proposal, approvalId: outcome.approval?.id ?? null });
  });

  return router;
}
