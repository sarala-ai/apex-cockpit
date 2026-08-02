import { describe, expect, it, vi } from "vitest";
import { initiativesMaterializer, getProposalMaterializer } from "../services/proposals.js";
import type { ProposalRecord } from "@paperclipai/shared";

/**
 * A fake db that records what materialisation tried to write. The point of
 * these tests is the create/update decision and the company scoping on it, not
 * drizzle — so the fake is the thinnest thing that can observe both.
 */
function fakeDb(options: { updateReturns?: Array<{ id: string }> } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const whereClauses: unknown[] = [];

  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return { returning: async () => [{ id: `new-${inserted.length}` }] };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updated.push(values);
        return {
          where: (clause: unknown) => {
            whereClauses.push(clause);
            return {
              returning: async () =>
                options.updateReturns ?? [{ id: "existing-1" }],
            };
          },
        };
      },
    }),
  };
  return { db: db as never, inserted, updated, whereClauses };
}

function record(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
  return {
    ref: "r1",
    provenance: { kind: "inferred", source: "47 commits" },
    fields: { title: "Run FinPilot and Bloom through APEX", budget: "8 weeks" },
    ...overrides,
  } as ProposalRecord;
}

describe("proposal materializer registry", () => {
  it("resolves the initiatives kind", () => {
    expect(getProposalMaterializer("initiatives")).toBe(initiativesMaterializer);
  });

  it("returns null for a kind nobody registered, rather than guessing", () => {
    expect(getProposalMaterializer("tasks")).toBeNull();
  });
});

describe("initiatives materializer", () => {
  const context = (db: never) => ({ db, companyId: "company-1", proposalId: "proposal-1" });

  it("CREATES an initiative for a record with no target", async () => {
    const { db, inserted } = fakeDb();
    const result = await initiativesMaterializer.materialize(context(db), [record()]);
    expect(result.created).toHaveLength(1);
    expect(result.updated).toHaveLength(0);
    expect(inserted[0]).toMatchObject({
      companyId: "company-1",
      level: "initiative",
      title: "Run FinPilot and Bloom through APEX",
    });
  });

  it("UPDATES the named initiative for a record that carries a target", async () => {
    const { db, updated } = fakeDb();
    const result = await initiativesMaterializer.materialize(context(db), [
      record({ targetId: "11111111-1111-4111-8111-111111111111", fields: { title: "Corrected" } }),
    ]);
    expect(result.updated).toEqual(["existing-1"]);
    expect(result.created).toHaveLength(0);
    expect(updated[0]).toMatchObject({ title: "Corrected" });
  });

  it("reports a target that matched nothing instead of silently creating one", async () => {
    const { db, inserted } = fakeDb({ updateReturns: [] });
    const result = await initiativesMaterializer.materialize(context(db), [
      record({ targetId: "11111111-1111-4111-8111-111111111111" }),
    ]);
    expect(inserted).toHaveLength(0);
    expect(result.errors[0].error).toContain("nothing was updated");
  });

  it("writes the record's provenance onto the initiative", async () => {
    const { db, inserted } = fakeDb();
    await initiativesMaterializer.materialize(context(db), [
      record({ provenance: { kind: "confirmed", source: "design doc" } }),
    ]);
    expect(inserted[0].provenance).toEqual({ kind: "confirmed", source: "design doc" });
  });

  it("never invents a stop condition", async () => {
    const { db, inserted } = fakeDb();
    await initiativesMaterializer.materialize(context(db), [record()]);
    expect(inserted[0].stopCondition).toBeNull();
  });

  it("never writes status — it is derived from projects", async () => {
    const { db, inserted } = fakeDb();
    await initiativesMaterializer.materialize(context(db), [
      record({ fields: { title: "X", status: "active" } as never }),
    ]);
    expect(inserted[0]).not.toHaveProperty("status");
  });

  it("skips a record the reviewer dropped", async () => {
    const { db, inserted, updated } = fakeDb();
    const result = await initiativesMaterializer.materialize(context(db), [
      record({ excluded: true }),
    ]);
    expect(result.skipped).toEqual(["r1"]);
    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it("reports an invalid record and materialises the rest of the set", async () => {
    const { db, inserted } = fakeDb();
    const result = await initiativesMaterializer.materialize(context(db), [
      record({ ref: "bad", fields: {} }),
      record({ ref: "good" }),
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].ref).toBe("bad");
    expect(result.created).toHaveLength(1);
    expect(inserted).toHaveLength(1);
  });
});

/**
 * The gate decision landing. Approve is the ONLY path that writes to the board
 * — that is the contract a proposal makes, and it is the one worth testing
 * directly rather than through the approvals route's full dependency graph.
 */
describe("onApprovalDecision", () => {
  function serviceDb(proposal: Record<string, unknown> | null) {
    const updates: Array<Record<string, unknown>> = [];
    const inserted: Array<Record<string, unknown>> = [];
    let updateTarget: "proposal" | "goal" = "proposal";

    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(proposal ? [proposal] : []),
          orderBy: () => Promise.resolve(proposal ? [proposal] : []),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Record<string, unknown>) => {
          inserted.push({ table, ...values });
          return { returning: async () => [{ id: "new-goal-1" }] };
        },
      }),
      update: (table: unknown) => {
        updateTarget = (table as { _?: { name?: string } })?._?.name === "goals" ? "goal" : "proposal";
        return {
          set: (values: Record<string, unknown>) => {
            updates.push({ target: updateTarget, ...values });
            return {
              where: () => ({ returning: async () => [{ id: "row-1", ...values }] }),
            };
          },
        };
      },
    };
    return { db: db as never, updates, inserted };
  }

  const baseProposal = {
    id: "proposal-1",
    companyId: "company-1",
    kind: "initiatives",
    status: "in_review",
    records: [record()],
  };

  it("materialises on approve", async () => {
    const { db, updates, inserted } = serviceDb(baseProposal);
    const { proposalService } = await import("../services/proposals.js");
    await proposalService(db).onApprovalDecision("approval-1", "approve");
    expect(inserted).toHaveLength(1);
    const proposalUpdate = updates.find((entry) => entry.status === "approved");
    expect(proposalUpdate).toBeTruthy();
    expect((proposalUpdate as any).materialization.created).toHaveLength(1);
  });

  it("writes NOTHING on request_changes and sends the set back", async () => {
    const { db, updates, inserted } = serviceDb(baseProposal);
    const { proposalService } = await import("../services/proposals.js");
    await proposalService(db).onApprovalDecision("approval-1", "request_changes");
    expect(inserted).toHaveLength(0);
    expect(updates).toEqual([{ target: "proposal", status: "changes_requested", updatedAt: expect.any(Date) }]);
  });

  it("writes NOTHING on reject", async () => {
    const { db, updates, inserted } = serviceDb(baseProposal);
    const { proposalService } = await import("../services/proposals.js");
    await proposalService(db).onApprovalDecision("approval-1", "reject");
    expect(inserted).toHaveLength(0);
    expect(updates[0]).toMatchObject({ status: "rejected" });
  });

  it("records the deployment error rather than failing a decision a person made", async () => {
    const { db, updates } = serviceDb({ ...baseProposal, kind: "unregistered-kind" });
    const { proposalService } = await import("../services/proposals.js");
    await proposalService(db).onApprovalDecision("approval-1", "approve");
    expect((updates[0] as any).materialization.errors[0].error).toContain("No materializer");
  });

  it("is a no-op for an approval that has no proposal", async () => {
    const { db, updates } = serviceDb(null);
    const { proposalService } = await import("../services/proposals.js");
    expect(await proposalService(db).onApprovalDecision("approval-1", "approve")).toBeNull();
    expect(updates).toHaveLength(0);
  });
});
