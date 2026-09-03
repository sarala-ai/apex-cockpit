import { describe, expect, it } from "vitest";
import { buildClaudeExecutionPermissionArgs, buildClaudeProbePermissionArgs } from "./permissions.js";

const SANDBOX_ALLOWED_TOOLS =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";

describe("claude-local remote permission args", () => {
  it("uses the canonical Bash tool grant for remote execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("uses the canonical Bash tool grant for remote probes", () => {
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: true })).toEqual([
      "--allowedTools",
      SANDBOX_ALLOWED_TOOLS,
    ]);
  });

  it("does not use Bash(*) because Claude Code treats Bash grants as command-prefix patterns", () => {
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
    });

    expect(allowedTools.split(" ")).toContain("Bash");
    expect(allowedTools).not.toContain("Bash(*)");
  });

  it("does not pass permission flags when skip-permissions is disabled", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true })).toEqual([]);
  });

  it("uses dangerously-skip-permissions for local execution", () => {
    expect(buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("uses dangerously-skip-permissions for local probes", () => {
    expect(buildClaudeProbePermissionArgs({ dangerouslySkipPermissions: true, targetIsRemote: false })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  describe("allowedToolsOverride (governed flow-commissioned runs)", () => {
    it("passes the override through as --allowedTools even with skip-permissions disabled", () => {
      expect(
        buildClaudeExecutionPermissionArgs({
          dangerouslySkipPermissions: false,
          targetIsRemote: false,
          allowedToolsOverride: "Read Grep Glob",
        }),
      ).toEqual(["--allowedTools", "Read Grep Glob"]);
    });

    it("wins over dangerouslySkipPermissions=true (never doubles up flags)", () => {
      expect(
        buildClaudeExecutionPermissionArgs({
          dangerouslySkipPermissions: true,
          targetIsRemote: false,
          allowedToolsOverride: "Read Grep Glob",
        }),
      ).toEqual(["--allowedTools", "Read Grep Glob"]);
    });

    it("is a no-op (existing behavior) when absent or empty", () => {
      expect(
        buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: false, allowedToolsOverride: null }),
      ).toEqual([]);
      expect(
        buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: false, allowedToolsOverride: "" }),
      ).toEqual([]);
    });
  });
});

describe("injected MCP server grants", () => {
  it("pre-approves the injected server's tools next to the governed grant", () => {
    expect(
      buildClaudeExecutionPermissionArgs({
        dangerouslySkipPermissions: false,
        targetIsRemote: true,
        allowedToolsOverride: "Read Bash",
        mcpServerGrants: ["apex-gateway"],
      }),
    ).toEqual(["--allowedTools", "Read Bash mcp__apex-gateway"]);
  });

  it("pre-approves the injected server's tools next to the broad remote whitelist", () => {
    const [, allowedTools] = buildClaudeExecutionPermissionArgs({
      dangerouslySkipPermissions: true,
      targetIsRemote: true,
      mcpServerGrants: ["apex-gateway"],
    });
    expect(allowedTools.endsWith(" mcp__apex-gateway")).toBe(true);
  });

  it("does not turn a prompting run into a grant", () => {
    expect(
      buildClaudeExecutionPermissionArgs({ dangerouslySkipPermissions: false, targetIsRemote: true, mcpServerGrants: ["apex-gateway"] }),
    ).toEqual([]);
  });
});

