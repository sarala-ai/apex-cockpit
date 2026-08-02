import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../apex/exec.js";
import { CliStepTargetRunner } from "../apex/steps/runner.js";
import { ApexUnavailableError } from "../apex/invoke.js";

vi.mock("../apex/exec.js", () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);

const runner = new CliStepTargetRunner("apex", "/launch");

function cliEnvelope(result: Record<string, unknown>, status = "success") {
  return JSON.stringify({ server: "workflow", tool: "run", tool_name: "run", status, result });
}

describe("CliStepTargetRunner.runWorkflow", () => {
  beforeEach(() => mockRun.mockReset());

  it("shells `apex run workflow run --execution-mode apply` with JSON params", async () => {
    mockRun.mockResolvedValue({
      status: "ok",
      stdout: cliEnvelope({ status: "success", instance_name: "i-1", steps_completed: ["a"] }),
    });

    const result = await runner.runWorkflow({ workflow: "simple-test", params: { test_param: "x" } });

    expect(result.ok).toBe(true);
    expect(mockRun).toHaveBeenCalledWith(
      "apex",
      [
        "--output",
        "json",
        "run",
        "workflow",
        "run",
        "--workflow",
        "simple-test",
        "--execution-mode",
        "apply",
        "--params",
        JSON.stringify({ test_param: "x" }),
      ],
      expect.any(Number),
      "/launch",
      undefined,
    );
  });

  it("a failed inner workflow run is not ok even when the CLI exits 0", async () => {
    mockRun.mockResolvedValue({
      status: "ok",
      stdout: cliEnvelope({ status: "failed", last_error: "step test_step exploded" }),
    });

    const result = await runner.runWorkflow({ workflow: "simple-test", params: {} });
    expect(result).toMatchObject({ ok: false, errorType: "workflow_failed" });
    if (!result.ok) expect(result.message).toContain("step test_step exploded");
  });

  it("preserves the classified error envelope from a non-zero exit", async () => {
    mockRun.mockResolvedValue({
      status: "failed",
      code: 1,
      stderr: "",
      // Error envelopes carry classification at top level and no `result`
      // key (verified live) — unwrapCliEnvelope passes them through intact.
      stdout: JSON.stringify({
        server: "workflow",
        tool: "run",
        status: "error",
        error: "Authentication expired. Run: gcloud auth login",
        error_type: "auth_expired",
      }),
    });

    const result = await runner.runWorkflow({ workflow: "simple-test", params: {} });
    expect(result).toMatchObject({ ok: false, errorType: "auth_expired" });
  });

  it("throws ApexUnavailableError when the binary is missing", async () => {
    mockRun.mockResolvedValue({ status: "missing" });
    await expect(runner.runWorkflow({ workflow: "w", params: {} })).rejects.toBeInstanceOf(
      ApexUnavailableError,
    );
  });

  it("an unparseable failure degrades to a classified invocation failure", async () => {
    mockRun.mockResolvedValue({ status: "failed", code: 2, stderr: "usage: apex ...", stdout: "" });
    const result = await runner.runWorkflow({ workflow: "w", params: {} });
    expect(result).toMatchObject({ ok: false, errorType: "apex_invocation_failed" });
  });
});

describe("CliStepTargetRunner.runCommand", () => {
  beforeEach(() => mockRun.mockReset());

  it("shells the named server tool with APEX_EXECUTION_MODE=apply", async () => {
    mockRun.mockResolvedValue({
      status: "ok",
      stdout: JSON.stringify({
        server: "health",
        tool: "generate_health_report",
        status: "success",
        result: { status: "success" },
      }),
    });

    const result = await runner.runCommand({
      tool: "health generate_health_report",
      args: ["--foo", "bar"],
    });

    expect(result.ok).toBe(true);
    expect(mockRun).toHaveBeenCalledWith(
      "apex",
      ["--output", "json", "run", "health", "generate-health-report", "--foo", "bar"],
      expect.any(Number),
      "/launch",
      { APEX_EXECUTION_MODE: "apply" },
    );
  });

  it("a domain-specific result status (e.g. 'healthy') still passes when the envelope succeeds", async () => {
    // Regression from the live acceptance run: generate_health_report returns
    // result.status "healthy"; only the ENVELOPE status is authoritative.
    mockRun.mockResolvedValue({
      status: "ok",
      stdout: JSON.stringify({
        server: "health",
        tool: "generate_health_report",
        status: "success",
        result: { status: "healthy", total_checks: 0 },
      }),
    });
    const result = await runner.runCommand({
      tool: "health generate_health_report",
      args: [],
    });
    expect(result.ok).toBe(true);
  });

  it("classifies a bare tool name as unresolvable without shelling anything", async () => {
    const result = await runner.runCommand({ tool: "ci_status_check", args: [] });
    expect(result).toMatchObject({ ok: false, errorType: "command_tool_unresolvable" });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("a blocked tool result is classified as blocked", async () => {
    mockRun.mockResolvedValue({
      status: "failed",
      code: 1,
      stderr: "",
      stdout: JSON.stringify({
        server: "health",
        tool: "generate_health_report",
        status: "blocked",
        message: "policy denied",
        result: {},
      }),
    });
    const result = await runner.runCommand({
      tool: "health generate_health_report",
      args: [],
    });
    expect(result).toMatchObject({ ok: false, errorType: "blocked" });
  });
});
