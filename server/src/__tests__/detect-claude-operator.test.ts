import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

const operatorAuth = vi.hoisted(() => ({ readWorkstationReport: vi.fn() }));
vi.mock("../apex/setup/operator-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apex/setup/operator-auth.js")>();
  return { ...actual, readWorkstationReport: operatorAuth.readWorkstationReport };
});
const exec = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../apex/exec.js", () => exec);

const { detectClaudeAuthForOperator, UNKNOWN_CLAUDE_DETECT } = await import("../apex/model-access/detect-claude.js");

const hosted = { PAPERCLIP_DEPLOYMENT_MODE: "authenticated" };
const base = {
  gcloud: { installed: true, account: "op@sarala.ai", live: true },
  adc: { live: true },
  gh: { installed: true, user: "operator" },
  apex: { installed: true, version: "0.9.0" },
};

describe("detectClaudeAuthForOperator", () => {
  afterEach(() => vi.clearAllMocks());

  it("hosted: the container's CLI is never the answer — no report means unknown", async () => {
    operatorAuth.readWorkstationReport.mockResolvedValue(null);
    expect(await detectClaudeAuthForOperator({} as Db, "user-1", hosted)).toEqual(UNKNOWN_CLAUDE_DETECT);
    expect(await detectClaudeAuthForOperator({} as Db, null, hosted)).toEqual(UNKNOWN_CLAUDE_DETECT);
    expect(exec.run).not.toHaveBeenCalled();
  });

  it("hosted: installed/mode come from the workstation report", async () => {
    const reportedAt = new Date();
    operatorAuth.readWorkstationReport.mockResolvedValue({
      report: { ...base, claude: { installed: true, version: "2.1.259", loggedIn: true } },
      reportedAt,
    });
    expect(await detectClaudeAuthForOperator({} as Db, "user-1", hosted)).toEqual({
      installed: true,
      mode: "subscription_local",
      source: "workstation",
      reportedAt: reportedAt.toISOString(),
    });
    operatorAuth.readWorkstationReport.mockResolvedValue({ report: { ...base, claude: { installed: true } }, reportedAt });
    expect(await detectClaudeAuthForOperator({} as Db, "user-1", hosted)).toMatchObject({ installed: true, mode: "unknown", source: "workstation" });
    operatorAuth.readWorkstationReport.mockResolvedValue({ report: { ...base, claude: { installed: false, loggedIn: null } }, reportedAt });
    expect(await detectClaudeAuthForOperator({} as Db, "user-1", hosted)).toMatchObject({ installed: false, mode: "none" });
    expect(exec.run).not.toHaveBeenCalled();
  });

  it("hosted: a stale report is unknown, not a claim", async () => {
    operatorAuth.readWorkstationReport.mockResolvedValue({
      report: { ...base, claude: { installed: true, loggedIn: true } },
      reportedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    });
    expect(await detectClaudeAuthForOperator({} as Db, "user-1", hosted)).toEqual(UNKNOWN_CLAUDE_DETECT);
  });

  it("local: the server probes itself", async () => {
    exec.run.mockResolvedValue({ status: "failed", stdout: "", stderr: "" });
    const local = await detectClaudeAuthForOperator({} as Db, "user-1", { ANTHROPIC_API_KEY: "" });
    expect(local.source).toBe("server");
    expect(operatorAuth.readWorkstationReport).not.toHaveBeenCalled();
  });
});
