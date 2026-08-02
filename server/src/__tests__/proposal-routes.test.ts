import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProposalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getByApprovalId: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  correctRecord: vi.fn(),
  submit: vi.fn(),
  onApprovalDecision: vi.fn(),
  kindDefinition: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({ decide: vi.fn() }),
  proposalService: () => mockProposalService,
  logActivity: mockLogActivity,
}));

const RECORD = {
  ref: "r1",
  targetId: "11111111-1111-4111-8111-111111111111",
  provenance: { kind: "inferred", source: "47 commits" },
  fields: { title: "Run FinPilot and Bloom through APEX", budget: "8 weeks" },
  note: null,
};

const PROPOSAL = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  companyId: "company-1",
  kind: "initiatives",
  title: "26 reconstructed initiatives",
  summary: "Reconstructed from six months of commits",
  status: "draft",
  records: [RECORD],
  proposedByAgentId: null,
  proposedByUserId: "board-user",
  approvalId: null,
  materializedAt: null,
  materialization: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

async function createApp(
  companyIds: string[] = ["company-1"],
  source: "local_implicit" | "session" = "local_implicit",
) {
  const { errorHandler } = await import("../middleware/index.js");
  const { proposalRoutes } = await import("../routes/proposals.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds,
      source,
      memberships: companyIds.map((companyId) => ({
        companyId,
        membershipRole: "admin",
        status: "active",
      })),
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", proposalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProposalService.getById.mockResolvedValue(PROPOSAL);
  mockProposalService.list.mockResolvedValue([PROPOSAL]);
  mockProposalService.create.mockImplementation(async (companyId: string, data: any) => ({
    ...PROPOSAL,
    ...data,
    companyId,
  }));
  mockProposalService.update.mockImplementation(async (id: string, data: any) => ({
    ...PROPOSAL,
    ...data,
    id,
  }));
});

describe("GET /proposal-kinds", () => {
  it("serves the registered kinds with their columns, so the UI never hardcodes them", async () => {
    const res = await request(await createApp()).get("/api/proposal-kinds");
    expect(res.status).toBe(200);
    const initiatives = res.body.find((entry: any) => entry.kind === "initiatives");
    expect(initiatives.label).toBe("Initiative");
    expect(initiatives.columns.map((column: any) => column.key)).toContain("stopCondition");
    // status is derived from projects; there is nothing to correct.
    expect(initiatives.columns.map((column: any) => column.key)).not.toContain("status");
  });
});

describe("proposal CRUD", () => {
  it("creates a proposal with its records", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/proposals")
      .send({ kind: "initiatives", title: "26 initiatives", records: [RECORD] });
    expect(res.status).toBe(201);
    expect(mockProposalService.create).toHaveBeenCalled();
  });

  it("refuses an unregistered kind rather than storing records nothing can render", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/proposals")
      .send({ kind: "tasks", title: "Some tasks", records: [] });
    // Rejected by the kind enum before the route's own check — either gate is
    // fine, the point is that records for a kind nothing can render are refused.
    expect(res.status).toBe(400);
  });

  it("refuses duplicate refs, because a ref is how a correction finds its row", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/proposals")
      .send({ kind: "initiatives", title: "X", records: [RECORD, { ...RECORD }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Duplicate record ref");
  });

  it("requires provenance on every record", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/proposals")
      .send({
        kind: "initiatives",
        title: "X",
        records: [{ ref: "r1", fields: { title: "A" } }],
      });
    expect(res.status).toBe(400);
  });

  it("refuses a company the actor cannot see", async () => {
    const res = await request(await createApp(["company-2"], "session")).get(
      "/api/companies/company-1/proposals",
    );
    expect(res.status).toBe(403);
  });

  it("scopes a fetched proposal to its own company", async () => {
    const res = await request(await createApp(["company-2"], "session")).get(
      `/api/proposals/${PROPOSAL.id}`,
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH one record — correction in place", () => {
  it("merges field corrections and touches no live object", async () => {
    mockProposalService.correctRecord.mockResolvedValue({
      proposal: PROPOSAL,
      record: { ...RECORD, fields: { ...RECORD.fields, budget: "12 weeks" } },
      fieldsError: null,
    });
    const res = await request(await createApp())
      .patch(`/api/proposals/${PROPOSAL.id}/records/r1`)
      .send({ fields: { budget: "12 weeks" } });
    expect(res.status).toBe(200);
    expect(mockProposalService.correctRecord).toHaveBeenCalledWith(
      PROPOSAL.id,
      "r1",
      { fields: { budget: "12 weeks" } },
      "board-user",
    );
    expect(res.body.record.fields.budget).toBe("12 weeks");
  });

  it("returns a validation problem as advisory, keeping the half-corrected row saveable", async () => {
    mockProposalService.correctRecord.mockResolvedValue({
      proposal: PROPOSAL,
      record: RECORD,
      fieldsError: "title: Too small",
    });
    const res = await request(await createApp())
      .patch(`/api/proposals/${PROPOSAL.id}/records/r1`)
      .send({ fields: { title: "" } });
    expect(res.status).toBe(200);
    expect(res.body.fieldsError).toBe("title: Too small");
  });

  it("404s on a ref that is not on this proposal", async () => {
    mockProposalService.correctRecord.mockResolvedValue({ error: "no_record" });
    const res = await request(await createApp())
      .patch(`/api/proposals/${PROPOSAL.id}/records/nope`)
      .send({ note: "hm" });
    expect(res.status).toBe(404);
  });

  it("refuses to correct a proposal the gate has already decided", async () => {
    mockProposalService.correctRecord.mockResolvedValue({ error: "closed" });
    const res = await request(await createApp())
      .patch(`/api/proposals/${PROPOSAL.id}/records/r1`)
      .send({ note: "too late" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("has been decided");
  });

  it("records a reviewer note without touching the fields", async () => {
    mockProposalService.correctRecord.mockResolvedValue({
      proposal: PROPOSAL,
      record: { ...RECORD, note: "This is really two initiatives" },
      fieldsError: null,
    });
    const res = await request(await createApp())
      .patch(`/api/proposals/${PROPOSAL.id}/records/r1`)
      .send({ note: "This is really two initiatives" });
    expect(res.body.record.note).toBe("This is really two initiatives");
  });
});

describe("POST /submit — the single gate", () => {
  it("opens one approval over the whole set", async () => {
    mockProposalService.submit.mockResolvedValue({
      proposal: { ...PROPOSAL, status: "in_review", approvalId: "approval-1" },
      approval: { id: "approval-1" },
    });
    const res = await request(await createApp())
      .post(`/api/proposals/${PROPOSAL.id}/submit`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.approvalId).toBe("approval-1");
  });

  it("refuses to open a gate over a set where every row was dropped", async () => {
    mockProposalService.getById.mockResolvedValue({
      ...PROPOSAL,
      records: [{ ...RECORD, excluded: true }],
    });
    const res = await request(await createApp())
      .post(`/api/proposals/${PROPOSAL.id}/submit`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("every record on this proposal is excluded");
  });

  it("names the records that do not match the kind rather than gating a bad set", async () => {
    mockProposalService.getById.mockResolvedValue({
      ...PROPOSAL,
      records: [{ ...RECORD, ref: "broken", fields: {} }],
    });
    const res = await request(await createApp())
      .post(`/api/proposals/${PROPOSAL.id}/submit`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.invalid[0].ref).toBe("broken");
  });
});

describe("GET /proposals/:id/export.csv", () => {
  it("exports the records for offline scanning, with provenance per row", async () => {
    const res = await request(await createApp()).get(`/api/proposals/${PROPOSAL.id}/export.csv`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text.startsWith("﻿")).toBe(true);
    expect(res.text).toContain("provenance_kind");
    expect(res.text).toContain("inferred");
    expect(res.text).toContain("Run FinPilot and Bloom through APEX");
  });
});
