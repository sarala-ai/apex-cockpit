import { describe, expect, it, vi } from "vitest";
import { ok, err } from "../apex/errors.js";
import {
  GITHUB_DONE_LABEL,
  GITHUB_PROMOTED_LABEL,
  parseGithubOriginId,
  reflectGithubIssueTransition,
} from "../apex/pipeline/github-issue-reflect.js";

function fakeSource() {
  return {
    addLabel: vi.fn(async () => ok(true)),
    comment: vi.fn(async () => ok(true)),
    close: vi.fn(async () => ok(true)),
  };
}

describe("parseGithubOriginId", () => {
  it("splits owner/repo#number", () => {
    expect(parseGithubOriginId("acme/repo#42")).toEqual({ repo: "acme/repo", number: 42 });
  });

  it("returns null when there is no owner/repo prefix", () => {
    expect(parseGithubOriginId("repo#42")).toBeNull();
  });

  it("returns null when there is no issue number", () => {
    expect(parseGithubOriginId("acme/repo#")).toBeNull();
  });

  it("returns null for a non-numeric suffix", () => {
    expect(parseGithubOriginId("acme/repo#abc")).toBeNull();
  });

  it("returns null when there is no # at all", () => {
    expect(parseGithubOriginId("acme/repo")).toBeNull();
  });
});

describe("reflectGithubIssueTransition", () => {
  const base = { originKind: "plugin:github", originId: "acme/repo#7", identifier: "APE-9" };

  it("labels + comments on promotion out of backlog", async () => {
    const source = fakeSource();
    const result = await reflectGithubIssueTransition(
      { ...base, status: "backlog" },
      { ...base, status: "todo" },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("promoted");
    expect(source.addLabel).toHaveBeenCalledWith("acme/repo", 7, GITHUB_PROMOTED_LABEL);
    expect(source.comment).toHaveBeenCalledWith("acme/repo", 7, expect.stringContaining("APE-9"));
    expect(source.close).not.toHaveBeenCalled();
  });

  it("labels + closes on done", async () => {
    const source = fakeSource();
    const result = await reflectGithubIssueTransition(
      { ...base, status: "in_progress" },
      { ...base, status: "done" },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("closed");
    expect(source.addLabel).toHaveBeenCalledWith("acme/repo", 7, GITHUB_DONE_LABEL);
    expect(source.close).toHaveBeenCalledWith("acme/repo", 7);
    expect(source.comment).not.toHaveBeenCalled();
  });

  it("labels + closes on cancelled", async () => {
    const source = fakeSource();
    const result = await reflectGithubIssueTransition(
      { ...base, status: "todo" },
      { ...base, status: "cancelled" },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("closed");
    expect(source.close).toHaveBeenCalledWith("acme/repo", 7);
  });

  it("skips when the issue is not plugin:github origin", async () => {
    const source = fakeSource();
    const result = await reflectGithubIssueTransition(
      { status: "backlog", originKind: "manual", originId: null },
      { status: "todo", originKind: "manual", originId: null },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("skipped");
    expect(source.addLabel).not.toHaveBeenCalled();
  });

  it("skips when the status did not change", async () => {
    const source = fakeSource();
    const result = await reflectGithubIssueTransition(
      { ...base, status: "todo" },
      { ...base, status: "todo" },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("skipped");
    expect(source.addLabel).not.toHaveBeenCalled();
  });

  it("skips a non-backlog, non-terminal transition (already promoted, moving between working states)", async () => {
    const source = fakeSource();
    const result = await reflectGithubIssueTransition(
      { ...base, status: "todo" },
      { ...base, status: "in_progress" },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("skipped");
    expect(source.addLabel).not.toHaveBeenCalled();
  });

  it("does not close upstream when a still-backlog mirror is locally cancelled (Finding 5d)", async () => {
    const source = fakeSource();
    const result = await reflectGithubIssueTransition(
      { ...base, status: "backlog" },
      { ...base, status: "cancelled" },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("skipped");
    expect(source.close).not.toHaveBeenCalled();
    expect(source.addLabel).not.toHaveBeenCalled();
  });

  it("does not close upstream when a still-backlog mirror is locally marked done (Finding 5d)", async () => {
    const source = fakeSource();
    const result = await reflectGithubIssueTransition(
      { ...base, status: "backlog" },
      { ...base, status: "done" },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("skipped");
    expect(source.close).not.toHaveBeenCalled();
  });

  it("classifies a reflection failure without throwing", async () => {
    const source = fakeSource();
    source.comment.mockResolvedValueOnce(err("tool-unauth", "gh is not authenticated"));
    const result = await reflectGithubIssueTransition(
      { ...base, status: "backlog" },
      { ...base, status: "todo" },
      { source: source as never, log: () => {} },
    );

    expect(result.action).toBe("failed");
    expect(result.detail).toContain("not authenticated");
  });
});
