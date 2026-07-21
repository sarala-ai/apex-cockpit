// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { conventionToken, suggestByConvention } from "./OrgScopingSection";

describe("suggestByConvention — loose company↔resource naming match", () => {
  it("matches GCP projects by leading token to the company name", () => {
    const projects = ["finpilot-dev", "finpilot-prod", "sarala-bloom-dev", "sarala-cicd", "local-abbey-491015"];
    expect(suggestByConvention(projects, "FinPilot")).toEqual(["finpilot-dev", "finpilot-prod"]);
  });

  it("matches repos (owner/name) on the leaf's leading token", () => {
    const repos = ["sarala-ai/finpilot-mcp", "sarala-ai/bloom", "sarala-ai/finpilot", "octocat/hello"];
    expect(suggestByConvention(repos, "FinPilot")).toEqual([
      "sarala-ai/finpilot-mcp",
      "sarala-ai/finpilot",
    ]);
  });

  it("is case/separator-insensitive and returns nothing for a blank company", () => {
    expect(suggestByConvention(["FinPilot_API"], "finpilot")).toEqual(["FinPilot_API"]);
    expect(suggestByConvention(["finpilot-dev"], "")).toEqual([]);
  });

  it("does not match unrelated names", () => {
    expect(suggestByConvention(["sarala-bloom-dev", "sarala-cicd"], "FinPilot")).toEqual([]);
  });

  it("conventionToken normalizes to alnum-only lowercase", () => {
    expect(conventionToken("Fin-Pilot_2")).toBe("finpilot2");
  });
});
