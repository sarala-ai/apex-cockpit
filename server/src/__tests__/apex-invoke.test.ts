import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readApexResult, unwrapMcpContent } from "../apex/invoke.js";

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
