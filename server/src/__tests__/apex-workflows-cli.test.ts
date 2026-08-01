import { describe, expect, it, vi, beforeEach } from "vitest";
import { WorkflowsCliClient } from "../apex/workflows-cli.js";
import { run } from "../apex/exec.js";

vi.mock("../apex/exec.js", () => ({ run: vi.fn() }));
const mockedRun = vi.mocked(run);

function mockRun(result: Awaited<ReturnType<typeof run>>) {
  mockedRun.mockResolvedValue(result);
}

describe("WorkflowsCliClient — degraded-CLI classification", () => {
  beforeEach(() => mockedRun.mockReset());

  it("classifies a missing apex binary as cli_missing_command", async () => {
    mockRun({ status: "missing" });
    const client = new WorkflowsCliClient();
    const result = await client.list();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error_type).toBe("cli_missing_command");
      expect(result.error.message).toBe("requires apex-platform with the workflows CLI (unreleased)");
    }
  });

  it("classifies non-JSON stdout (an installed CLI that doesn't recognize `workflows`) as cli_missing_command", async () => {
    mockRun({ status: "failed", code: 2, stderr: "Error: No such command 'workflows'.", stdout: "" });
    const client = new WorkflowsCliClient();
    const result = await client.list();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("cli_missing_command");
  });

  it("passes through the CLI's own structured error envelope on a non-zero exit", async () => {
    mockRun({
      status: "failed",
      code: 1,
      stderr: "",
      stdout: JSON.stringify({ status: "error", error_type: "not_found", message: "No workflow named 'ghost'.", remediation: "list workflows" }),
    });
    const client = new WorkflowsCliClient();
    const result = await client.show("ghost");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error_type).toBe("not_found");
      expect(result.error.message).toBe("No workflow named 'ghost'.");
    }
  });

  it("parses a successful list envelope against the shared schema", async () => {
    mockRun({
      status: "ok",
      stdout: JSON.stringify({
        status: "success",
        workflows: [{ name: "w1", path: "/p", source: "apex-core", layer: "built-in", lifecycle: "stable", shadowed_count: 0, shadows_other_layer: false }],
      }),
    });
    const client = new WorkflowsCliClient();
    const result = await client.list();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.workflows).toHaveLength(1);
  });

  it("classifies a success envelope that fails the shared schema as parse_failed", async () => {
    mockRun({ status: "ok", stdout: JSON.stringify({ status: "success", workflows: "not-an-array" }) });
    const client = new WorkflowsCliClient();
    const result = await client.list();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("parse_failed");
  });
});
