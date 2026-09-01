import { describe, expect, it, vi, beforeEach } from "vitest";
import { CapabilitySyncCliClient, parseLastJsonLine } from "../apex/capability-sync-cli.js";
import { run } from "../apex/exec.js";

vi.mock("../apex/exec.js", () => ({ run: vi.fn() }));
const mockedRun = vi.mocked(run);

function mockRun(result: Awaited<ReturnType<typeof run>>) {
  mockedRun.mockResolvedValue(result);
}

const SUCCESS_SUMMARY = {
  status: "success",
  synced_at: "2026-08-01T00:00:00.000Z",
  sources: ["acme"],
  items: [{ alias: "acme", kind: "workflows", path: "~/.apex/company/acme/workflows/deploy.yaml", status: "synced", digest: "abc123" }],
  diverged: [],
  pending_skills: [],
};

describe("parseLastJsonLine", () => {
  it("parses a single-line JSON blob", () => {
    expect(parseLastJsonLine('{"status":"success"}')).toEqual({ status: "success" });
  });

  it("finds the JSON on the LAST line, ignoring human progress lines before it", () => {
    const stdout = ["Cloning acme (shallow)...", "Copying workflows/ -> ~/.apex/company/acme/workflows/", JSON.stringify(SUCCESS_SUMMARY)].join("\n");
    expect(parseLastJsonLine(stdout)).toEqual(SUCCESS_SUMMARY);
  });

  it("returns null when nothing parses", () => {
    expect(parseLastJsonLine("not json\nstill not json")).toBeNull();
  });

  it("returns null for empty stdout", () => {
    expect(parseLastJsonLine("")).toBeNull();
  });
});

describe("CapabilitySyncCliClient — degraded-CLI classification", () => {
  beforeEach(() => mockedRun.mockReset());

  it("classifies a missing apex binary as cli_missing_command", async () => {
    mockRun({ status: "missing" });
    const client = new CapabilitySyncCliClient();
    const result = await client.sync();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error_type).toBe("cli_missing_command");
      expect(result.error.message).toBe("requires apex-core with the capabilities CLI (unreleased)");
    }
  });

  it("classifies non-JSON stdout (an installed CLI that doesn't recognize `capabilities`) as cli_missing_command", async () => {
    mockRun({ status: "failed", code: 2, stderr: "Error: No such command 'capabilities'.", stdout: "" });
    const client = new CapabilitySyncCliClient();
    const result = await client.sync();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("cli_missing_command");
  });

  it("passes through the CLI's own classified error envelope on a non-zero exit", async () => {
    mockRun({
      status: "failed",
      code: 1,
      stderr: "",
      stdout: JSON.stringify({ status: "error", error_type: "not_configured", message: "No capability_sources configured.", remediation: "Add capability_sources to ~/.apex/settings.yaml" }),
    });
    const client = new CapabilitySyncCliClient();
    const result = await client.sync();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error_type).toBe("not_configured");
      expect(result.error.message).toBe("No capability_sources configured.");
    }
  });

  it("parses a successful sync envelope against the shared schema, taking the LAST json line", async () => {
    mockRun({
      status: "ok",
      stdout: `Cloning acme...\n${JSON.stringify(SUCCESS_SUMMARY)}`,
    });
    const client = new CapabilitySyncCliClient();
    const result = await client.sync();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toHaveLength(1);
      expect(result.data.sources).toEqual(["acme"]);
    }
  });

  it("surfaces diverged items and pending skills in the parsed summary", async () => {
    const summary = {
      ...SUCCESS_SUMMARY,
      diverged: [{ alias: "acme", kind: "workflows", path: "~/.apex/company/acme/workflows/deploy.yaml", status: "diverged", digest: "def456" }],
      pending_skills: [{ alias: "acme", path: "~/.apex/company/acme/skills/lint", digest: "ghi789", reason: "skills_auto not enabled" }],
    };
    mockRun({ status: "ok", stdout: JSON.stringify(summary) });
    const client = new CapabilitySyncCliClient();
    const result = await client.sync();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.diverged).toHaveLength(1);
      expect(result.data.pending_skills).toHaveLength(1);
    }
  });

  it("classifies a success envelope that fails the shared schema as parse_failed", async () => {
    mockRun({ status: "ok", stdout: JSON.stringify({ status: "success", synced_at: "x", sources: "not-an-array", items: [], diverged: [], pending_skills: [] }) });
    const client = new CapabilitySyncCliClient();
    const result = await client.sync();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("parse_failed");
  });

  it("places --output json before the capabilities group, and threads --dry-run/--accept-skills", async () => {
    mockRun({ status: "ok", stdout: JSON.stringify(SUCCESS_SUMMARY) });
    const client = new CapabilitySyncCliClient();
    await client.sync({ dryRun: true, acceptSkills: true });
    const args = mockedRun.mock.calls[0]?.[1];
    expect(args).toEqual(["--output", "json", "capabilities", "sync", "--dry-run", "--accept-skills"]);
  });

  it("sets APEX_COMPANY_SLUG in the child env when a companySlug is given, omits it otherwise", async () => {
    mockRun({ status: "ok", stdout: JSON.stringify(SUCCESS_SUMMARY) });
    const client = new CapabilitySyncCliClient();

    await client.sync({ companySlug: "acme" });
    expect(mockedRun.mock.calls[0]?.[4]).toEqual({ APEX_COMPANY_SLUG: "acme" });

    mockedRun.mockClear();
    await client.sync();
    expect(mockedRun.mock.calls[0]?.[4]).toBeUndefined();
  });
});
