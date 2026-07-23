import { describe, expect, it, vi, beforeEach } from "vitest";
import { z } from "zod";
import {
  readApexResult,
  unwrapMcpContent,
  CliApexInvoker,
  ApexUnavailableError,
  ApexInvocationError,
} from "../apex/invoke.js";
import { run } from "../apex/exec.js";

vi.mock("../apex/exec.js", () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);

const Schema = z.object({ runs: z.array(z.object({ id: z.string(), ok: z.boolean() })) });
const payload = { runs: [{ id: "r1", ok: true }] };

describe("readApexResult (central APEX result reader)", () => {
  it("parses + validates a CLI --output json string", () => {
    const out = readApexResult(JSON.stringify(payload), Schema);
    expect(out).toEqual(payload);
  });

  it("unwraps + validates an MCP content-array result", () => {
    const mcp = { content: [{ type: "text", text: JSON.stringify(payload) }] };
    const out = readApexResult(mcp, Schema);
    expect(out).toEqual(payload);
  });

  it("validates an already-parsed plain object", () => {
    const out = readApexResult(payload, Schema);
    expect(out).toEqual(payload);
  });

  it("throws (loudly, here) on a contract mismatch", () => {
    const bad = { runs: [{ id: "r1", ok: "yes" }] }; // ok should be boolean
    expect(() => readApexResult(bad, Schema)).toThrow(z.ZodError);
  });

  it("unwrapMcpContent passes a plain object through unchanged", () => {
    expect(unwrapMcpContent(payload)).toBe(payload);
  });
});

describe("CliApexInvoker", () => {
  beforeEach(() => mockRun.mockReset());

  const OutSchema = z.object({
    status: z.string(),
    services: z.array(z.object({ name: z.string() })),
  });

  it("builds `apex --output json run <mount> <tool-dashed> --flags` and validates output", async () => {
    mockRun.mockResolvedValue({
      status: "ok",
      stdout: JSON.stringify({
        server: "observability",
        tool: "list_agent_services",
        status: "success",
        services: [{ name: "orchestrator-dev" }],
      }),
    });
    const out = await new CliApexInvoker("apex").invoke(
      "observability",
      "list_agent_services",
      { project_id: "p", region: "us-central1" },
      OutSchema,
    );
    expect(out.services[0].name).toBe("orchestrator-dev");

    const [bin, args] = mockRun.mock.calls[0];
    expect(bin).toBe("apex");
    expect((args as string[]).slice(0, 5)).toEqual([
      "--output",
      "json",
      "run",
      "observability",
      "list-agent-services",
    ]);
    expect(args).toContain("--project-id");
    expect(args).toContain("us-central1");
    // snake_case params become dashed flags
    expect(args).not.toContain("--project_id");
  });

  it("throws ApexUnavailableError when the binary is missing", async () => {
    mockRun.mockResolvedValue({ status: "missing" });
    await expect(
      new CliApexInvoker().invoke("observability", "x", {}, z.object({})),
    ).rejects.toBeInstanceOf(ApexUnavailableError);
  });

  it("throws ApexInvocationError on non-zero exit", async () => {
    mockRun.mockResolvedValue({ status: "failed", code: 1, stderr: "boom" });
    await expect(
      new CliApexInvoker().invoke("observability", "x", {}, z.object({})),
    ).rejects.toBeInstanceOf(ApexInvocationError);
  });
});
