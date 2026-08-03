import { describe, expect, it } from "vitest";
import { SANDBOX_ALLOWED_TOOLS } from "@paperclipai/adapter-claude-local/server";
import {
  applyGovernedAdapterConfigOverride,
  clearGovernedAdapterConfigOverride,
  derivePermissionPolicy,
  READ_ONLY_BROAD_ALLOWED_TOOLS,
  READ_REPOS_ALLOWED_TOOLS,
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

  /**
   * read-repos is no longer an alias. It was one, on the untested assumption
   * that --allowedTools gates by tool name only — which made "repo reader" a
   * grant that could not read a repository's history. The CLI honours
   * `Bash(git log:*)` scoping (measured; see run-policy's module doc), so the
   * profile now grants read-only VCS verbs and no write verb of any kind.
   */
  it("derives read-repos as read-only tools plus scoped read-only VCS commands", () => {
    const policy = derivePermissionPolicy({ profile: "read-repos" });
    expect(policy.profile).toBe("read-repos");
    expect(policy.nativeTools).toBe(READ_REPOS_ALLOWED_TOOLS);
    expect(policy.nativeTools).not.toBe(READ_ONLY_BROAD_ALLOWED_TOOLS);
    expect(policy.notes.some((n) => n.includes("read-repos"))).toBe(true);

    // History is reachable...
    expect(policy.nativeTools).toContain("Bash(git log:*)");
    expect(policy.nativeTools).toContain("Bash(gh pr view:*)");
    // ...and every read-only tool of the narrower profile is still present.
    for (const tool of READ_ONLY_BROAD_ALLOWED_TOOLS.split(" ")) {
      expect(policy.nativeTools.split(" ")).toContain(tool);
    }
    // Nothing that writes: no bare Bash, no Edit/Write, no write verb, and no
    // `gh api` (a prefix matcher cannot tell a GET from a POST).
    expect(policy.nativeTools.split(" ")).not.toContain("Bash");
    for (const forbidden of ["Edit", "Write", "WebFetch", "WebSearch"]) {
      expect(policy.nativeTools.split(" ")).not.toContain(forbidden);
    }
    for (const forbidden of [
      "git push", "git commit", "git checkout", "git fetch", "git pull",
      "git stash", "git branch", "git tag", "git config",
      "gh api", "gh pr create", "gh pr merge", "gh issue create",
    ]) {
      expect(policy.nativeTools).not.toContain(forbidden);
    }
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
