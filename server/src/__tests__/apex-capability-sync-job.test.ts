import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilitySyncCliResult } from "../apex/capability-sync-cli.js";
import {
  capabilitySyncIntervalMs,
  getLastCapabilitySync,
  resetLastCapabilitySyncForTests,
  runCapabilitySync,
} from "../apex/capability-sync-job.js";

function fakeClient(result: CapabilitySyncCliResult) {
  return { sync: vi.fn(async () => result) };
}

const SUCCESS: CapabilitySyncCliResult = {
  ok: true,
  data: {
    status: "success",
    synced_at: "2026-08-01T00:00:00.000Z",
    sources: ["acme"],
    items: [{ alias: "acme", kind: "workflows", path: "~/.apex/company/acme/workflows/deploy.yaml", status: "synced", digest: "abc" }],
    diverged: [],
    pending_skills: [],
  },
};

const DIVERGED: CapabilitySyncCliResult = {
  ok: true,
  data: {
    status: "success",
    synced_at: "2026-08-01T01:00:00.000Z",
    sources: ["acme"],
    items: [{ alias: "acme", kind: "workflows", path: "~/.apex/company/acme/workflows/deploy.yaml", status: "diverged", digest: "xyz" }],
    diverged: [{ alias: "acme", kind: "workflows", path: "~/.apex/company/acme/workflows/deploy.yaml", status: "diverged", digest: "xyz" }],
    pending_skills: [{ alias: "acme", path: "~/.apex/company/acme/skills/lint", digest: "def", reason: "skills_auto not enabled" }],
  },
};

const CLI_MISSING: CapabilitySyncCliResult = {
  ok: false,
  error: {
    status: "error",
    error_type: "cli_missing_command",
    message: "requires apex-core with the capabilities CLI (unreleased)",
    remediation: "Install apex-core.",
  },
};

const REAL_ERROR: CapabilitySyncCliResult = {
  ok: false,
  error: { status: "error", error_type: "clone_failed", message: "could not clone acme/store", remediation: null },
};

describe("runCapabilitySync", () => {
  beforeEach(() => {
    resetLastCapabilitySyncForTests();
  });

  it("stores and returns a success summary, logging a one-line ok summary", async () => {
    const log = vi.fn();
    const client = fakeClient(SUCCESS);
    const result = await runCapabilitySync({ client: client as never, log });

    expect(result).toEqual(SUCCESS.data);
    expect(getLastCapabilitySync()?.summary).toEqual(SUCCESS.data);
    expect(log.mock.calls.some(([line]) => line.includes("sync ok"))).toBe(true);
  });

  it("surfaces diverged items and pending skills in both the return value and the stored snapshot", async () => {
    const log = vi.fn();
    const client = fakeClient(DIVERGED);
    const result = await runCapabilitySync({ client: client as never, log });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.diverged).toHaveLength(1);
      expect(result.pending_skills).toHaveLength(1);
    }
    expect(getLastCapabilitySync()?.summary).toEqual(DIVERGED.data);
    expect(log.mock.calls.some(([line]) => line.includes("diverged") && line.includes("pending skill"))).toBe(true);
  });

  it("degrades quietly on cli_missing_command — no error-level noise, still updates the snapshot", async () => {
    const log = vi.fn();
    const client = fakeClient(CLI_MISSING);
    const result = await runCapabilitySync({ client: client as never, log });

    expect(result).toEqual(CLI_MISSING.error);
    expect(getLastCapabilitySync()?.summary).toEqual(CLI_MISSING.error);
    expect(log).toHaveBeenCalledTimes(1);
    const [line] = log.mock.calls[0] as [string];
    expect(line).toContain("skipped");
    expect(line).not.toMatch(/failed/i);
  });

  it("logs a genuine sync failure distinctly from the quiet cli_missing_command path", async () => {
    const log = vi.fn();
    const client = fakeClient(REAL_ERROR);
    const result = await runCapabilitySync({ client: client as never, log });

    expect(result).toEqual(REAL_ERROR.error);
    expect(log.mock.calls.some(([line]) => line.includes("sync failed") && line.includes("clone_failed"))).toBe(true);
  });

  it("getLastCapabilitySync is null before any run and a pure read afterward (no CLI call)", async () => {
    expect(getLastCapabilitySync()).toBeNull();
    const client = fakeClient(SUCCESS);
    await runCapabilitySync({ client: client as never, log: () => {} });
    expect(getLastCapabilitySync()).not.toBeNull();
    expect(client.sync).toHaveBeenCalledTimes(1);
    // Reading again does not call sync again.
    getLastCapabilitySync();
    expect(client.sync).toHaveBeenCalledTimes(1);
  });
});

describe("capabilitySyncIntervalMs", () => {
  it("defaults to 12h when unset", () => {
    expect(capabilitySyncIntervalMs({})).toBe(12 * 60 * 60 * 1000);
  });

  it("honors APEX_CAPABILITY_SYNC_HOURS", () => {
    expect(capabilitySyncIntervalMs({ APEX_CAPABILITY_SYNC_HOURS: "3" })).toBe(3 * 60 * 60 * 1000);
  });

  it("0 disables (returned as 0, not the default)", () => {
    expect(capabilitySyncIntervalMs({ APEX_CAPABILITY_SYNC_HOURS: "0" })).toBe(0);
  });
});
