import { describe, it, expect } from "vitest";
import { ExecInPodTimeoutError, classifyExecInPodFailure } from "../../src/pod-exec.js";

describe("classifyExecInPodFailure", () => {
  it("marks only the watchdog rejection as a timeout", () => {
    const result = classifyExecInPodFailure(new ExecInPodTimeoutError("execInPod timed out after 5000ms"));
    expect(result).toEqual({ timedOut: true, stderr: "execInPod timed out after 5000ms" });
  });

  it("reports a forbidden exec upgrade as a failure, not a timeout", () => {
    const result = classifyExecInPodFailure(new Error("Unexpected server response: 403"));
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("403");
  });

  it("stringifies non-Error rejections", () => {
    expect(classifyExecInPodFailure("socket hang up")).toEqual({ timedOut: false, stderr: "socket hang up" });
  });
});
