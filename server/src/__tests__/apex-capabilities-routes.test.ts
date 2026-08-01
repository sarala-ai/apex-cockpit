import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { apexCapabilitiesRoutes } from "../routes/apex-capabilities.js";
import { runCapabilitySync } from "../apex/capability-sync-job.js";
import * as capabilitySyncJob from "../apex/capability-sync-job.js";

vi.mock("../apex/capability-sync-job.js", async () => {
  const actual = await vi.importActual<typeof import("../apex/capability-sync-job.js")>(
    "../apex/capability-sync-job.js",
  );
  return { ...actual, runCapabilitySync: vi.fn(), getLastCapabilitySync: vi.fn(actual.getLastCapabilitySync) };
});
const mockRunCapabilitySync = vi.mocked(runCapabilitySync);
const mockGetLastCapabilitySync = vi.mocked(capabilitySyncJob.getLastCapabilitySync);

function app(actor: Express.Request["actor"] = { type: "agent", agentId: "agent-1" }) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  instance.use(apexCapabilitiesRoutes());
  instance.use(errorHandler);
  return instance;
}

const SUCCESS_SNAPSHOT = {
  ranAt: "2026-08-01T00:00:00.000Z",
  summary: {
    status: "success" as const,
    synced_at: "2026-08-01T00:00:00.000Z",
    sources: ["acme"],
    items: [{ alias: "acme", kind: "workflows" as const, path: "~/.apex/company/acme/workflows/deploy.yaml", status: "diverged" as const, digest: "abc" }],
    diverged: [{ alias: "acme", kind: "workflows" as const, path: "~/.apex/company/acme/workflows/deploy.yaml", status: "diverged" as const, digest: "abc" }],
    pending_skills: [{ alias: "acme", path: "~/.apex/company/acme/skills/lint", digest: "def", reason: "skills_auto not enabled" }],
  },
};

const CLI_MISSING_SNAPSHOT = {
  ranAt: "2026-08-01T00:00:00.000Z",
  summary: {
    status: "error" as const,
    error_type: "cli_missing_command",
    message: "requires apex-core with the capabilities CLI (unreleased)",
    remediation: null,
  },
};

describe("GET /apex/capabilities/sync", () => {
  beforeEach(() => {
    mockRunCapabilitySync.mockReset();
    mockGetLastCapabilitySync.mockReset();
  });

  it("returns an honest empty state before any run since boot", async () => {
    mockGetLastCapabilitySync.mockReturnValue(null);
    const res = await request(app()).get("/apex/capabilities/sync");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ranAt: null, summary: null });
  });

  it("returns the last in-memory snapshot without triggering a new sync", async () => {
    mockGetLastCapabilitySync.mockReturnValue(SUCCESS_SNAPSHOT);
    const res = await request(app()).get("/apex/capabilities/sync");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUCCESS_SNAPSHOT);
    expect(mockRunCapabilitySync).not.toHaveBeenCalled();
  });

  it("returns a degraded cli_missing_command snapshot as-is (banner suppression is a UI concern)", async () => {
    mockGetLastCapabilitySync.mockReturnValue(CLI_MISSING_SNAPSHOT);
    const res = await request(app()).get("/apex/capabilities/sync");
    expect(res.status).toBe(200);
    expect(res.body.summary.error_type).toBe("cli_missing_command");
  });

  it("requires board-or-agent auth", async () => {
    const res = await request(app({ type: "none", source: "none" } as never)).get("/apex/capabilities/sync");
    expect(res.status).toBe(403);
  });
});

describe("POST /apex/capabilities/sync", () => {
  beforeEach(() => {
    mockRunCapabilitySync.mockReset();
    mockGetLastCapabilitySync.mockReset();
  });

  it("runs a sync once and returns the resulting summary, incl. diverged + pending-skills lists", async () => {
    mockRunCapabilitySync.mockResolvedValueOnce(SUCCESS_SNAPSHOT.summary);
    mockGetLastCapabilitySync.mockReturnValue(SUCCESS_SNAPSHOT);

    const res = await request(app()).post("/apex/capabilities/sync").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(SUCCESS_SNAPSHOT);
    expect(res.body.summary.diverged).toHaveLength(1);
    expect(res.body.summary.pending_skills).toHaveLength(1);
    expect(mockRunCapabilitySync).toHaveBeenCalledTimes(1);
  });

  it("degrades to the classified cli_missing_command payload instead of erroring", async () => {
    mockRunCapabilitySync.mockResolvedValueOnce(CLI_MISSING_SNAPSHOT.summary);
    mockGetLastCapabilitySync.mockReturnValue(CLI_MISSING_SNAPSHOT);

    const res = await request(app()).post("/apex/capabilities/sync").send({});

    expect(res.status).toBe(200);
    expect(res.body.summary.status).toBe("error");
    expect(res.body.summary.error_type).toBe("cli_missing_command");
  });

  it("surfaces an unexpected job failure as a 500 rather than crashing the route", async () => {
    mockRunCapabilitySync.mockRejectedValueOnce(new Error("unexpected"));

    const res = await request(app()).post("/apex/capabilities/sync").send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("unexpected");
  });

  it("requires board-or-agent auth", async () => {
    const res = await request(app({ type: "none", source: "none" } as never)).post("/apex/capabilities/sync").send({});
    expect(res.status).toBe(403);
    expect(mockRunCapabilitySync).not.toHaveBeenCalled();
  });
});
