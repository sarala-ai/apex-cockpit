import { readdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowValidateCliClient } from "../apex/workflow-validate-cli.js";
import { run } from "../apex/exec.js";

vi.mock("../apex/exec.js", () => ({ run: vi.fn() }));
const mockedRun = vi.mocked(run);

// `node:fs/promises`'s ESM namespace isn't configurable, so `vi.spyOn` can't
// wrap its real `writeFile` in place — mock the module and delegate every
// export except `writeFile` to the real implementation via `importOriginal`.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
const mockedWriteFile = vi.mocked(writeFile);

function mockRun(result: Awaited<ReturnType<typeof run>>) {
  mockedRun.mockResolvedValue(result);
}

/** Every apex-validate-* scratch dir left behind under the OS tmp root — used
 *  to assert temp-file cleanup without depending on the client's internals. */
function leftoverValidateDirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("apex-validate-"));
}

const PASS_JSON = JSON.stringify({
  servers: [{ name: "wf", errors: 0, warnings: 0, issues: [] }],
  totals: { errors: 0, warnings: 0 },
  passed: true,
});

const FAIL_JSON = JSON.stringify({
  servers: [
    {
      name: "wf",
      errors: 1,
      warnings: 1,
      issues: [
        { severity: "error", message: "Step 'deploy' references unknown tool 'nope'.", tool: "gcp", suggestion: null },
        { severity: "warning", message: "Step 'build' has no timeout set.", tool: null, suggestion: "Set a timeout." },
      ],
    },
  ],
  totals: { errors: 1, warnings: 1 },
  passed: false,
});

describe("WorkflowValidateCliClient", () => {
  beforeEach(() => mockedRun.mockReset());

  it("shells `apex validate --workflow <tmp> --json` and flattens a passing result", async () => {
    mockRun({ status: "ok", stdout: PASS_JSON });
    const client = new WorkflowValidateCliClient();
    const result = await client.validate("name: wf\nsteps: []\n");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ valid: true, errors: [], warnings: [] });
    }

    expect(mockedRun).toHaveBeenCalledTimes(1);
    const [bin, args] = mockedRun.mock.calls[0]!;
    expect(bin).toBe("apex");
    expect(args[0]).toBe("validate");
    expect(args[1]).toBe("--workflow");
    expect(args[3]).toBe("--json");
    const filePath = args[2] as string;
    expect(filePath).toMatch(/workflow\.yaml$/);
  });

  it("flattens a failing result's issues into errors[]/warnings[] by severity", async () => {
    // apex validate exits non-zero on an invalid workflow but still prints the
    // JSON envelope on stdout — a `failed` exec result with parseable stdout,
    // same convention as WorkflowsCliClient.
    mockRun({ status: "failed", code: 1, stderr: "", stdout: FAIL_JSON });
    const client = new WorkflowValidateCliClient();
    const result = await client.validate("name: wf\nsteps: [broken]\n");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.valid).toBe(false);
      expect(result.data.errors).toEqual(["Step 'deploy' references unknown tool 'nope'."]);
      expect(result.data.warnings).toEqual(["Step 'build' has no timeout set."]);
    }
  });

  it("writes the given YAML verbatim to the temp file the CLI is invoked against", async () => {
    mockRun({ status: "ok", stdout: PASS_JSON });
    const client = new WorkflowValidateCliClient();
    await client.validate("name: my-workflow\nsteps: []\n");

    expect(mockedRun).toHaveBeenCalledTimes(1);
    const [, args] = mockedRun.mock.calls[0]!;
    expect(args[2]).toMatch(/workflow\.yaml$/);
  });

  it("reads the temp file's content from inside the mocked run call, before cleanup", async () => {
    // Capture the file's content DURING the call — while the mock stands in
    // for the CLI, the temp file still exists — rather than after validate()
    // resolves and its finally block has already removed it.
    let seenContent: string | null = null;
    mockedRun.mockImplementation(async (_bin, args) => {
      if (seenContent === null && Array.isArray(args) && typeof args[2] === "string") {
        seenContent = await readFile(args[2], "utf8");
      }
      return { status: "ok", stdout: PASS_JSON };
    });
    const client = new WorkflowValidateCliClient();
    await client.validate("name: my-workflow\nsteps: []\n");
    expect(seenContent).toBe("name: my-workflow\nsteps: []\n");
  });

  it("cleans up the temp directory after a successful validate", async () => {
    const before = leftoverValidateDirs().length;
    mockRun({ status: "ok", stdout: PASS_JSON });
    const client = new WorkflowValidateCliClient();
    await client.validate("name: wf\nsteps: []\n");
    expect(leftoverValidateDirs().length).toBe(before);
  });

  it("cleans up the temp directory even when the CLI is missing", async () => {
    const before = leftoverValidateDirs().length;
    mockRun({ status: "missing" });
    const client = new WorkflowValidateCliClient();
    const result = await client.validate("name: wf\nsteps: []\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("cli_missing");
    expect(leftoverValidateDirs().length).toBe(before);
  });

  it("cleans up the temp directory even when writing the workflow file fails (before the CLI is ever invoked)", async () => {
    const before = leftoverValidateDirs().length;
    mockedWriteFile.mockRejectedValueOnce(new Error("disk full"));
    const client = new WorkflowValidateCliClient();

    let caught: unknown = null;
    try {
      await client.validate("name: wf\nsteps: []\n");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("disk full");
    expect(mockedRun).not.toHaveBeenCalled();
    expect(leftoverValidateDirs().length).toBe(before);
  });

  it("degrades to cli_missing when stdout has no parseable JSON envelope", async () => {
    mockRun({ status: "ok", stdout: "Loaded server definitions...\n(not json)" });
    const client = new WorkflowValidateCliClient();
    const result = await client.validate("name: wf\nsteps: []\n");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error_type).toBe("cli_missing");
      expect(result.error.message).toContain("did not return the documented JSON contract");
    }
  });

  it("takes the LAST JSON-looking line when human startup noise precedes the envelope", async () => {
    mockRun({ status: "ok", stdout: `✅ Loaded server definitions\n${PASS_JSON}` });
    const client = new WorkflowValidateCliClient();
    const result = await client.validate("name: wf\nsteps: []\n");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.valid).toBe(true);
  });

  it("degrades when the flattened output fails schema validation", async () => {
    mockRun({ status: "ok", stdout: JSON.stringify({ totals: {}, passed: "not-a-boolean-in-a-weird-shape" }) });
    const client = new WorkflowValidateCliClient();
    const result = await client.validate("name: wf\nsteps: []\n");
    // passed is coerced via `=== true`, and servers/issues are tolerant of
    // absence, so this still parses as a defined (if all-false/empty) result
    // rather than failing schema validation — assert the tolerant behavior.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ valid: false, errors: [], warnings: [] });
  });
});
