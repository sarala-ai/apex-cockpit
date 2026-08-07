import { describe, expect, it } from "vitest";
import {
  agentWritesRepositories,
  allowedToolsGrantRepositoryWrite,
} from "./agent-repo-capability.js";

// The three roster grants, verbatim from run-policy's profiles. Copied here on
// purpose rather than imported: this file's job is to prove the answer for the
// grants the product actually ships, and an import would let both sides drift
// together without a test noticing.
const BOUNDED =
  "Task AskUserQuestion Bash CronCreate CronDelete CronList Edit " +
  "EnterPlanMode EnterWorktree ExitPlanMode ExitWorktree Glob Grep Monitor " +
  "NotebookEdit PushNotification Read RemoteTrigger ScheduleWakeup Skill " +
  "TaskOutput TaskStop TodoWrite ToolSearch WebFetch WebSearch Write";
const READ_ONLY_BROAD = "AskUserQuestion Glob Grep Monitor Read TaskOutput TaskStop ToolSearch";
const READ_REPOS = `${READ_ONLY_BROAD} Bash(git log:*) Bash(git show:*) Bash(gh pr view:*)`;

describe("allowedToolsGrantRepositoryWrite", () => {
  it("says yes for the bounded grant — the only profile that can change code", () => {
    expect(allowedToolsGrantRepositoryWrite(BOUNDED)).toBe(true);
  });

  it("says no for read-only-broad", () => {
    expect(allowedToolsGrantRepositoryWrite(READ_ONLY_BROAD)).toBe(false);
  });

  it("says no for read-repos: scoped Bash(git log:*) is not a shell", () => {
    // This is the distinction the whole grammar rests on. A prefix-scoped Bash
    // grant cannot run an arbitrary command, so an agent holding it reads a
    // repository's history and writes nothing.
    expect(allowedToolsGrantRepositoryWrite(READ_REPOS)).toBe(false);
  });

  it("says yes for a bare Bash token, which is a shell", () => {
    expect(allowedToolsGrantRepositoryWrite("Read Glob Bash")).toBe(true);
  });

  it("recognizes a comma-separated grant — the CLI accepts both separators", () => {
    // The adapter passes the string verbatim to --allowedTools, and the CLI
    // splits on commas as well as spaces. Reading "Read,Grep,Edit" as one
    // unrecognized token would call a writing grant read-only — fail-open.
    expect(allowedToolsGrantRepositoryWrite("Read,Grep,Edit")).toBe(true);
    expect(allowedToolsGrantRepositoryWrite("Read,Grep")).toBe(false);
  });
});

describe("agentWritesRepositories", () => {
  it("is true for an Implementer-shaped agent (bounded on claude_local)", () => {
    expect(
      agentWritesRepositories({
        adapterType: "claude_local",
        adapterConfig: { dangerouslySkipPermissions: false, allowedTools: BOUNDED },
      }),
    ).toBe(true);
  });

  it("is false for a Specifier-shaped agent (read-only-broad)", () => {
    expect(
      agentWritesRepositories({
        adapterType: "claude_local",
        adapterConfig: { dangerouslySkipPermissions: false, allowedTools: READ_ONLY_BROAD },
      }),
    ).toBe(false);
  });

  it("is false for a Product-Assistant-shaped agent (read-repos)", () => {
    expect(
      agentWritesRepositories({
        adapterType: "claude_local",
        adapterConfig: { dangerouslySkipPermissions: false, allowedTools: READ_REPOS },
      }),
    ).toBe(false);
  });

  it("treats an ABSENT grant on a local coding adapter as writing repos", () => {
    // The load-bearing case. No grant on claude_local is full bypass, not
    // restriction — so the codebase warning must fire, not be suppressed.
    expect(agentWritesRepositories({ adapterType: "claude_local", adapterConfig: {} })).toBe(true);
    expect(agentWritesRepositories({ adapterType: "claude_local", adapterConfig: null })).toBe(true);
    expect(agentWritesRepositories({ adapterType: "claude_local" })).toBe(true);
  });

  it("is false for an adapter that has no working directory at all", () => {
    expect(agentWritesRepositories({ adapterType: "process", adapterConfig: {} })).toBe(false);
    expect(agentWritesRepositories({ adapterType: "http", adapterConfig: null })).toBe(false);
  });

  it("ignores an empty or whitespace grant and falls back to the adapter default", () => {
    expect(
      agentWritesRepositories({ adapterType: "codex_local", adapterConfig: { allowedTools: "   " } }),
    ).toBe(true);
  });
});
