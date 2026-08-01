import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../apex/exec.js";
import {
  FlowDefinitionError,
  listFlowDefinitions,
  loadFlowDefinition,
} from "../apex/flow/definition.js";
import { ApexUnavailableError } from "../apex/invoke.js";

vi.mock("../apex/exec.js", () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);

const NOOP_FLOW = {
  name: "noop-verify",
  version: "1.0",
  description: "Minimal end-to-end chore flow",
  ticket_type: "chore",
  nodes: [
    {
      id: "run",
      kind: "workflow",
      workflow: { workflow: "simple-test", params: { test_param: "noop-verify" } },
      check: null,
      agent: null,
      gate: null,
      on_fail: "pause",
    },
    {
      id: "verify",
      kind: "check",
      workflow: null,
      check: { tool: "health generate_health_report", args: [], pass_criteria: "exit_code == 0" },
      agent: null,
      gate: null,
      on_fail: "pause",
    },
  ],
};

describe("loadFlowDefinition", () => {
  beforeEach(() => mockRun.mockReset());

  it("loads and validates a flow via `apex flows show --output json`", async () => {
    mockRun.mockResolvedValue({
      status: "ok",
      stdout: JSON.stringify({ status: "success", path: "/repo/flows/noop-verify.yml", flow: NOOP_FLOW }),
    });

    const loaded = await loadFlowDefinition("noop-verify");

    expect(mockRun).toHaveBeenCalledWith(
      expect.any(String),
      ["--output", "json", "flows", "show", "noop-verify"],
      expect.any(Number),
      expect.any(String),
    );
    expect(loaded.path).toBe("/repo/flows/noop-verify.yml");
    expect(loaded.flow.name).toBe("noop-verify");
    expect(loaded.flow.nodes.map((n) => n.kind)).toEqual(["workflow", "check"]);
  });

  it("preserves the CLI's classified not_found error", async () => {
    mockRun.mockResolvedValue({
      status: "failed",
      code: 1,
      stderr: "",
      stdout: JSON.stringify({ status: "error", error_type: "not_found", error: "Flow 'x' not found." }),
    });

    const err = await loadFlowDefinition("x").catch((e) => e);
    expect(err).toBeInstanceOf(FlowDefinitionError);
    expect((err as FlowDefinitionError).errorType).toBe("not_found");
  });

  it("classifies contract-violating output loudly", async () => {
    mockRun.mockResolvedValue({
      status: "ok",
      stdout: JSON.stringify({ status: "success", path: "/x.yml", flow: { name: "x", nodes: [] } }),
    });

    const err = await loadFlowDefinition("x").catch((e) => e);
    expect(err).toBeInstanceOf(FlowDefinitionError);
    expect((err as FlowDefinitionError).errorType).toBe("flow_contract_violation");
  });

  it("throws ApexUnavailableError when the CLI is missing", async () => {
    mockRun.mockResolvedValue({ status: "missing" });
    await expect(loadFlowDefinition("x")).rejects.toBeInstanceOf(ApexUnavailableError);
  });
});

describe("listFlowDefinitions", () => {
  beforeEach(() => mockRun.mockReset());

  it("returns summary rows including per-flow classified errors", async () => {
    mockRun.mockResolvedValue({
      status: "ok",
      stdout: JSON.stringify({
        status: "success",
        flows: [
          { name: "chore", path: "/f/chore.yml", version: "1.0", ticket_type: "chore", description: "d", node_count: 3, gate_count: 0 },
          { name: "broken", path: "/f/broken.yml", error_type: "invalid_flow", error: "bad yaml" },
        ],
      }),
    });

    const rows = await listFlowDefinitions();
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe("chore");
    expect(rows[1].error_type).toBe("invalid_flow");
  });
});
