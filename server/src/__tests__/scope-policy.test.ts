import { describe, expect, it } from "vitest";
import { authorizeScope, isGovernancePosture, isReadScopeAction } from "../apex/scope-policy.js";
import type { AuthorizationDecision } from "../services/authorization.js";

function engineDecision(allowed: boolean, explanation = "engine says so"): AuthorizationDecision {
  return {
    allowed,
    action: "org_scope:write",
    explanation,
    reason: allowed ? "allow_org_role" : "deny_org_role",
  };
}

describe("authorizeScope — thin posture adapter over the real engine", () => {
  it("individual: all-allow, no filtering, no engine decision required", () => {
    for (const action of ["binding.read", "binding.write", "posture.write", "discovery.read", "company.create"] as const) {
      const d = authorizeScope({ posture: "individual", action });
      expect(d.allow).toBe(true);
      expect(d.visibility).toBe("all");
      expect(d.scopeFilter([1, 2, 3])).toEqual([1, 2, 3]);
    }
  });

  it("team/enterprise: maps the engine ALLOW decision (authority comes from the engine)", () => {
    const d = authorizeScope({
      posture: "enterprise",
      action: "binding.write",
      engineDecision: engineDecision(true, "Org owner may write scope/posture."),
    });
    expect(d.allow).toBe(true);
    expect(d.reason).toBe("Org owner may write scope/posture.");
    expect(d.visibility).toBe("all");
  });

  it("team/enterprise: maps the engine DENY decision", () => {
    const d = authorizeScope({
      posture: "team",
      action: "binding.write",
      engineDecision: engineDecision(false, "Org role 'member' cannot write; requires owner or admin."),
    });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/owner or admin/i);
    expect(d.visibility).toBe("none");
  });

  it("team/enterprise WITHOUT an engine decision fails closed (no local re-decide, no parallel matrix)", () => {
    const d = authorizeScope({ posture: "team", action: "binding.write" });
    expect(d.allow).toBe(false);
    expect(d.reason).toMatch(/engine authorization/i);
    expect(d.visibility).toBe("none");
  });

  it("isReadScopeAction splits reads from writes", () => {
    expect(isReadScopeAction("binding.read")).toBe(true);
    expect(isReadScopeAction("posture.read")).toBe(true);
    expect(isReadScopeAction("discovery.read")).toBe(true);
    expect(isReadScopeAction("binding.write")).toBe(false);
    expect(isReadScopeAction("posture.write")).toBe(false);
    expect(isReadScopeAction("company.create")).toBe(false);
  });

  it("isGovernancePosture guards the vocabulary", () => {
    expect(isGovernancePosture("individual")).toBe(true);
    expect(isGovernancePosture("team")).toBe(true);
    expect(isGovernancePosture("enterprise")).toBe(true);
    expect(isGovernancePosture("root")).toBe(false);
    expect(isGovernancePosture(undefined)).toBe(false);
  });
});
