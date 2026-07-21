import { describe, expect, it } from "vitest";
import { authorizeScope, isGovernancePosture } from "../apex/scope-policy.js";

describe("authorizeScope — the single scope-authz seam", () => {
  it("individual posture: all-allow, no read filtering (fully implemented path)", () => {
    for (const action of ["binding.read", "binding.write", "posture.write", "discovery.read"] as const) {
      const d = authorizeScope({ posture: "individual", action, role: null });
      expect(d.allow).toBe(true);
      expect(d.visibility).toBe("all");
      // scopeFilter is identity under individual.
      expect(d.scopeFilter([1, 2, 3])).toEqual([1, 2, 3]);
    }
  });

  it("individual: even with no role, writes are allowed (single-owner assumption)", () => {
    const d = authorizeScope({ posture: "individual", action: "binding.write", role: undefined });
    expect(d.allow).toBe(true);
  });

  it("enterprise (scaffold): writes require owner/admin, denied for a plain member", () => {
    const denied = authorizeScope({ posture: "enterprise", action: "binding.write", role: "member" });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toMatch(/owner\/admin/i);

    for (const role of ["owner", "admin"] as const) {
      expect(authorizeScope({ posture: "enterprise", action: "binding.write", role }).allow).toBe(true);
    }
    // Instance admin bypasses role.
    expect(
      authorizeScope({ posture: "enterprise", action: "binding.write", role: "member", isInstanceAdmin: true }).allow,
    ).toBe(true);
  });

  it("team/enterprise (scaffold): reads are allowed (no filtering yet)", () => {
    const d = authorizeScope({ posture: "team", action: "binding.read", role: "member" });
    expect(d.allow).toBe(true);
    expect(d.scopeFilter(["a", "b"])).toEqual(["a", "b"]);
  });

  it("isGovernancePosture guards the vocabulary", () => {
    expect(isGovernancePosture("individual")).toBe(true);
    expect(isGovernancePosture("team")).toBe(true);
    expect(isGovernancePosture("enterprise")).toBe(true);
    expect(isGovernancePosture("root")).toBe(false);
    expect(isGovernancePosture(undefined)).toBe(false);
  });
});
