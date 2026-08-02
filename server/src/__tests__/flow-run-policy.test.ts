import { describe, expect, it } from "vitest";
import { SANDBOX_ALLOWED_TOOLS } from "@paperclipai/adapter-claude-local/server";
import {
  applyGovernedAdapterConfigOverride,
  clearGovernedAdapterConfigOverride,
  derivePermissionPolicy,
  READ_ONLY_BROAD_ALLOWED_TOOLS,
} from "../apex/steps/run-policy.js";

describe("derivePermissionPolicy", () => {
  it("defaults to the bounded profile when no permissions are declared", () => {
    const policy = derivePermissionPolicy(undefined);
    expect(policy.profile).toBe("bounded");
    expect(policy.permissionMode).toBe("governed");
    expect(policy.nativeTools).toBe(SANDBOX_ALLOWED_TOOLS);
    expect(policy.mcpTools).toEqual([]);
    expect(policy.notes).toEqual([]);
  });

  it("derives the bounded profile explicitly", () => {
    const policy = derivePermissionPolicy({ profile: "bounded" });
    expect(policy.profile).toBe("bounded");
    expect(policy.nativeTools).toBe(SANDBOX_ALLOWED_TOOLS);
  });

  it("derives read-only-broad as a strict read-only tool grant (no Edit/Write/Bash)", () => {
    const policy = derivePermissionPolicy({ profile: "read-only-broad" });
    expect(policy.profile).toBe("read-only-broad");
    expect(policy.nativeTools).toBe(READ_ONLY_BROAD_ALLOWED_TOOLS);
    const tools = policy.nativeTools.split(" ");
    for (const forbidden of ["Edit", "Write", "Bash", "WebFetch", "WebSearch"]) {
      expect(tools).not.toContain(forbidden);
    }
    expect(tools).toContain("Read");
  });

  it("aliases read-repos to read-only-broad enforcement in v1, with a recorded note", () => {
    const policy = derivePermissionPolicy({ profile: "read-repos" });
    expect(policy.profile).toBe("read-repos");
    expect(policy.nativeTools).toBe(READ_ONLY_BROAD_ALLOWED_TOOLS);
    expect(policy.notes.some((n) => n.includes("read-repos"))).toBe(true);
  });

  it("falls back to bounded (the safest default) on an unrecognized profile, with a note", () => {
    const policy = derivePermissionPolicy({ profile: "root-access" });
    expect(policy.profile).toBe("bounded");
    expect(policy.notes.some((n) => n.includes("unrecognized"))).toBe(true);
  });

  it("falls back to bounded on garbage input (non-object) without throwing", () => {
    const policy = derivePermissionPolicy("not-an-object");
    expect(policy.profile).toBe("bounded");
    expect(policy.notes.length).toBeGreaterThan(0);
  });

  it("passes through declared mcpTools verbatim", () => {
    const policy = derivePermissionPolicy({ profile: "bounded", mcpTools: ["mcp__github__create_pr", "  ", 42] });
    expect(policy.mcpTools).toEqual(["mcp__github__create_pr"]);
  });

  it("ignores a non-array mcpTools with a note", () => {
    const policy = derivePermissionPolicy({ profile: "bounded", mcpTools: "not-an-array" });
    expect(policy.mcpTools).toEqual([]);
    expect(policy.notes.some((n) => n.includes("mcpTools"))).toBe(true);
  });
});

describe("applyGovernedAdapterConfigOverride / clearGovernedAdapterConfigOverride", () => {
  it("sets dangerouslySkipPermissions=false and the profile's allowedTools grant", () => {
    const policy = derivePermissionPolicy({ profile: "bounded" });
    const merged = applyGovernedAdapterConfigOverride(null, policy);
    expect(merged).toEqual({
      dangerouslySkipPermissions: false,
      allowedTools: SANDBOX_ALLOWED_TOOLS,
    });
  });

  it("preserves unrelated existing adapter config keys (e.g. a human-set model override)", () => {
    const policy = derivePermissionPolicy({ profile: "read-only-broad" });
    const merged = applyGovernedAdapterConfigOverride({ model: "claude-opus-4-6" }, policy);
    expect(merged.model).toBe("claude-opus-4-6");
    expect(merged.dangerouslySkipPermissions).toBe(false);
    expect(merged.allowedTools).toBe(READ_ONLY_BROAD_ALLOWED_TOOLS);
  });

  it("overwrites a stale governed grant from a previous node with the new profile's grant", () => {
    const boundedPolicy = derivePermissionPolicy({ profile: "bounded" });
    const stale = applyGovernedAdapterConfigOverride(null, boundedPolicy);
    const readOnlyPolicy = derivePermissionPolicy({ profile: "read-only-broad" });
    const fresh = applyGovernedAdapterConfigOverride(stale, readOnlyPolicy);
    expect(fresh.allowedTools).toBe(READ_ONLY_BROAD_ALLOWED_TOOLS);
  });

  it("clears exactly the two governed keys, preserving anything else set", () => {
    const policy = derivePermissionPolicy({ profile: "bounded" });
    const merged = applyGovernedAdapterConfigOverride({ model: "claude-opus-4-6" }, policy);
    const cleared = clearGovernedAdapterConfigOverride(merged);
    expect(cleared).toEqual({ model: "claude-opus-4-6" });
  });

  it("clears down to null when nothing else was set", () => {
    const policy = derivePermissionPolicy(undefined);
    const merged = applyGovernedAdapterConfigOverride(null, policy);
    expect(clearGovernedAdapterConfigOverride(merged)).toBeNull();
  });

  it("is a no-op clearing an already-empty/absent override", () => {
    expect(clearGovernedAdapterConfigOverride(null)).toBeNull();
    expect(clearGovernedAdapterConfigOverride(undefined)).toBeNull();
  });
});
