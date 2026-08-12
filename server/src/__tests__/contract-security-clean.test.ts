import { describe, expect, it } from "vitest";
import { RUN_CONTRACTS, isRunContract, resolveContractRunTarget } from "../apex/pipeline/contract-targets.js";
import type { Db } from "@paperclipai/db";

/** Minimal stand-in for the one query `resolveContractRunTarget` runs. Kept
 *  here rather than reaching for a real Postgres because what is under test is
 *  the resolution decision, not the SQL. */
function dbReturning(workspace: Record<string, unknown> | null): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => ({ then: (fn: (rows: unknown[]) => unknown) => fn(workspace ? [workspace] : []) }),
  };
  return { select: () => chain } as unknown as Db;
}

describe("security_clean contract", () => {
  it("is a run contract", () => {
    expect(RUN_CONTRACTS).toContain("security_clean");
    expect(isRunContract("security_clean")).toBe(true);
  });

  it("resolves to a COMMAND target, not a shell one", async () => {
    // checks_pass resolves to shell because a project's check command is
    // arbitrary by design. Here a shell string would let the project define
    // its own idea of "clean" and defeat the gate, so the tool AND the report
    // shape the gate reads are both pinned.
    const result = await resolveContractRunTarget(
      dbReturning({ name: "cockpit", cwd: "/srv/cockpit", checkCommand: null, deployWorkflow: null }),
      { companyId: "c1", projectId: "p1", contract: "security_clean" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toEqual({
      type: "command",
      tool: "security scan-secrets",
      args: ["--path", "/srv/cockpit"],
    });
  });

  it("needs no per-project declaration, unlike checks_pass and deployed", async () => {
    // "run this stack's tests" and "ship this stack" are stack-specific, so a
    // project that declares neither must HOLD. "look for committed secrets" is
    // the same operation everywhere, with rules that ship inside apex — so
    // this contract can never hold on not-configured, and a workspace with no
    // checkCommand and no deployWorkflow still resolves.
    const bare = dbReturning({ name: "bare", cwd: null, checkCommand: null, deployWorkflow: null });

    const security = await resolveContractRunTarget(bare, {
      companyId: "c1", projectId: "p1", contract: "security_clean",
    });
    expect(security.ok).toBe(true);
    if (security.ok) expect(security.target).toMatchObject({ args: ["--path", "."] });

    const checks = await resolveContractRunTarget(bare, {
      companyId: "c1", projectId: "p1", contract: "checks_pass",
    });
    expect(checks.ok).toBe(false);
    if (!checks.ok) expect(checks.errorType).toBe("check_command_not_configured");
  });

  it("still refuses when there is no project to resolve against", async () => {
    const result = await resolveContractRunTarget(dbReturning(null), {
      companyId: "c1", projectId: null, contract: "security_clean",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe("contract_unresolvable");
  });
});
