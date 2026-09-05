/**
 * DocsCliClient degradation — mirrors workflows-cli.test.ts's contract for
 * `apex workflows`: a missing/unrecognized `apex` binary must classify as
 * `cli_missing_command` on every method, never throw.
 *
 * Points `bin` at a path that cannot exist rather than relying on whatever
 * `apex` happens (or doesn't) to be on this machine's PATH — the point of
 * this suite is the classification, not the live CLI's actual behavior.
 */
import { describe, expect, it } from "vitest";
import { DocsCliClient } from "../apex/docs-cli.js";

const MISSING_BIN = "/nonexistent/apex-docs-cli-test-binary-xyz";

describe("DocsCliClient — missing/degraded CLI", () => {
  const client = new DocsCliClient(MISSING_BIN, 2000);

  it("list() classifies as cli_missing_command", async () => {
    const result = await client.list();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.status).toBe("error");
      expect(result.error.error_type).toBe("cli_missing_command");
      expect(result.error.remediation).toBeTruthy();
    }
  });

  it("show() classifies as cli_missing_command", async () => {
    const result = await client.show("some-doc-id");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("cli_missing_command");
  });

  it("search() classifies as cli_missing_command", async () => {
    const result = await client.search("deploy cloud run", { limit: 5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("cli_missing_command");
  });

  it("tags() classifies as cli_missing_command", async () => {
    const result = await client.tags();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("cli_missing_command");
  });

  it("related() classifies as cli_missing_command", async () => {
    const result = await client.related("some-doc-id");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.error_type).toBe("cli_missing_command");
  });

  it("passes --kind/--stage filters through to list() as repeated flags", async () => {
    // Still a missing binary — this only proves filterArgs doesn't throw
    // building the arg list, and the degraded result still comes back clean.
    const result = await client.list({ kind: ["guide", "runbook"], stage: ["2"] });
    expect(result.ok).toBe(false);
  });
});
