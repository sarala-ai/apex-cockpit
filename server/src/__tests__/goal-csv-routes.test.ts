import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  withDerivedStatus: vi.fn(),
  projectSummariesByGoal: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({ getTelemetryClient: mockGetTelemetryClient }));
vi.mock("../services/index.js", () => ({
  accessService: () => ({ decide: vi.fn() }),
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
}));

const INITIATIVE = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  title: "Run FinPilot and Bloom through APEX",
  description: "Migrate both products off Terraform",
  level: "initiative",
  status: "planned",
  parentId: null,
  ownerAgentId: null,
  closure: null,
  closureReason: null,
  assumptions: null,
  budget: "8 weeks",
  stopCondition: null,
  hypothesis: 'Adoption follows the first product that ships on it, "properly"',
  validationCriteria: null,
  provenance: { kind: "inferred", source: "47 commits, March–May" },
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const OTHER_LEVEL_GOAL = {
  ...INITIATIVE,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Ship the platform",
  level: "company",
  provenance: null,
  hypothesis: null,
  budget: null,
};

async function createApp(
  actorCompanyIds: string[] = ["company-1"],
  // `local_implicit` is the single-user laptop actor and bypasses company
  // scoping by design; a cross-company test has to use a session actor or it
  // proves nothing.
  source: "local_implicit" | "session" = "local_implicit",
) {
  const { errorHandler } = await import("../middleware/index.js");
  const { goalRoutes } = await import("../routes/goals.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: actorCompanyIds,
      source,
      memberships: actorCompanyIds.map((companyId) => ({
        companyId,
        membershipRole: "admin",
        status: "active",
      })),
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", goalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function unauthenticatedApp() {
  const { errorHandler } = await import("../middleware/index.js");
  const { goalRoutes } = await import("../routes/goals.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "none" };
    next();
  });
  app.use("/api", goalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGoalService.list.mockResolvedValue([INITIATIVE, OTHER_LEVEL_GOAL]);
  mockGoalService.withDerivedStatus.mockImplementation(async (rows: any[]) =>
    rows.map((row) => ({ ...row, derivedStatus: row.level === "initiative" ? "active" : null })),
  );
  mockGoalService.projectSummariesByGoal.mockResolvedValue(
    new Map([
      [
        INITIATIVE.id,
        [
          { id: "p1", name: "Cloud Run provider", status: "completed", createdAt: new Date(1) },
          { id: "p2", name: "Secret Manager", status: "in_progress", createdAt: new Date(2) },
        ],
      ],
    ]),
  );
  mockGoalService.update.mockImplementation(async (id: string, data: any) => ({
    ...INITIATIVE,
    ...data,
    id,
  }));
  mockGoalService.create.mockImplementation(async (_companyId: string, data: any) => ({
    ...INITIATIVE,
    ...data,
    id: "33333333-3333-4333-8333-333333333333",
  }));
});

describe("GET goals/export.csv", () => {
  it("serves a CSV attachment with a BOM", async () => {
    const res = await request(await createApp()).get(
      "/api/companies/company-1/goals/export.csv?level=initiative",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("initiative-company-1.csv");
    expect(res.text.startsWith("﻿")).toBe(true);
  });

  it("filters to the requested level", async () => {
    const res = await request(await createApp()).get(
      "/api/companies/company-1/goals/export.csv?level=initiative",
    );
    expect(res.text).toContain("Run FinPilot and Bloom through APEX");
    expect(res.text).not.toContain("Ship the platform");
  });

  it("rejects an unknown level rather than exporting everything", async () => {
    const res = await request(await createApp()).get(
      "/api/companies/company-1/goals/export.csv?level=epic",
    );
    expect(res.status).toBe(400);
  });

  it("summarises projects in created order so two exports diff cleanly", async () => {
    const res = await request(await createApp()).get(
      "/api/companies/company-1/goals/export.csv?level=initiative",
    );
    expect(res.text).toContain("Cloud Run provider:completed; Secret Manager:in_progress");
  });

  it("refuses a company the actor cannot see", async () => {
    const res = await request(await createApp(["company-2"], "session")).get(
      "/api/companies/company-1/goals/export.csv",
    );
    expect(res.status).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await request(await unauthenticatedApp()).get(
      "/api/companies/company-1/goals/export.csv",
    );
    expect(res.status).toBe(401);
  });
});

describe("POST goals/import.csv", () => {
  async function post(csv: string, query = "") {
    return request(await createApp())
      .post(`/api/companies/company-1/goals/import.csv${query}`)
      .set("Content-Type", "text/csv")
      .send(csv);
  }

  it("reports zero changes for an unedited export — the round-trip invariant", async () => {
    const exported = await request(await createApp()).get(
      "/api/companies/company-1/goals/export.csv?level=initiative",
    );
    const res = await post(exported.text);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.updated).toBe(0);
    expect(res.body.unchanged).toBe(1);
    expect(res.body.notices).toBe(0);
  });

  it("is a dry run by default and writes nothing", async () => {
    const res = await post(`id,title,budget\n${INITIATIVE.id},,12 weeks\n`);
    expect(res.body.applied).toBe(false);
    expect(res.body.updated).toBe(1);
    expect(res.body.results[0].changes).toEqual([
      { field: "budget", from: "8 weeks", to: "12 weeks" },
    ]);
    expect(mockGoalService.update).not.toHaveBeenCalled();
    expect(mockGoalService.create).not.toHaveBeenCalled();
  });

  it("writes only with ?apply=true", async () => {
    const res = await post(`id,title,budget\n${INITIATIVE.id},,12 weeks\n`, "?apply=true");
    expect(res.body.applied).toBe(true);
    expect(mockGoalService.update).toHaveBeenCalledWith(INITIATIVE.id, { budget: "12 weeks" });
  });

  it("leaves untouched cells alone — blank means unchanged", async () => {
    await post(`id,title,budget,hypothesis,description\n${INITIATIVE.id},,12 weeks,,\n`, "?apply=true");
    expect(mockGoalService.update).toHaveBeenCalledWith(INITIATIVE.id, { budget: "12 weeks" });
  });

  it("clears a field on the -- token", async () => {
    await post(`id,hypothesis\n${INITIATIVE.id},--\n`, "?apply=true");
    expect(mockGoalService.update).toHaveBeenCalledWith(INITIATIVE.id, { hypothesis: null });
  });

  it("creates when the id cell is blank", async () => {
    const res = await post("id,title,budget\n,Zero-token agents,4 weeks\n", "?apply=true");
    expect(res.body.created).toBe(1);
    expect(mockGoalService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ title: "Zero-token agents", level: "initiative" }),
    );
    expect(res.body.results[0].id).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("ignores derived_status and says so as a notice, not an error", async () => {
    const res = await post(`id,derived_status\n${INITIATIVE.id},delivered\n`);
    expect(res.body.errors).toBe(0);
    expect(res.body.results[0].notices.join(" ")).toContain("derived_status is computed");
  });

  it("reports an edited projects column as ignored and says the column is read-only", async () => {
    const res = await post(`id,projects\n${INITIATIVE.id},Something new:completed\n`);
    expect(res.body.results[0].notices.join(" ")).toContain("projects is computed");
    expect(res.body.notes.join(" ")).toContain("projects column is read-only");
  });

  it("reports a bad row with its line number and keeps going", async () => {
    const res = await post(
      `id,title,closure\n${INITIATIVE.id},,shipped\n,Another initiative,\n`,
    );
    expect(res.body.errors).toBe(1);
    expect(res.body.created).toBe(1);
    expect(res.body.results[0]).toMatchObject({ row: 2, action: "error" });
    expect(res.body.results[1]).toMatchObject({ row: 3, action: "create" });
  });

  it("refuses to touch a goal id from another company", async () => {
    const res = await post("id,title\n99999999-9999-4999-8999-999999999999,Renamed\n");
    expect(res.body.results[0].action).toBe("error");
    expect(res.body.results[0].error).toContain("No initiative with id");
    expect(mockGoalService.update).not.toHaveBeenCalled();
  });

  it("refuses to treat a non-initiative goal as an initiative", async () => {
    const res = await post(`id,title\n${OTHER_LEVEL_GOAL.id},Renamed\n`);
    expect(res.body.results[0].error).toContain('is a "company" goal');
  });

  it("handles quoted fields containing commas and newlines", async () => {
    const res = await post(
      `id,description\n${INITIATIVE.id},"Line one, with a comma\nline two"\n`,
    );
    expect(res.body.results[0].changes[0].to).toBe("Line one, with a comma\nline two");
  });

  it("accepts a JSON body carrying the sheet, for callers that cannot post text", async () => {
    const res = await request(await createApp())
      .post("/api/companies/company-1/goals/import.csv")
      .send({ csv: `id,budget\n${INITIATIVE.id},12 weeks\n` });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });

  it("refuses a company the actor cannot see", async () => {
    const res = await request(await createApp(["company-2"], "session"))
      .post("/api/companies/company-1/goals/import.csv")
      .set("Content-Type", "text/csv")
      .send("id,title\n,X\n");
    expect(res.status).toBe(403);
  });
});
