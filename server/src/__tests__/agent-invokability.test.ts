import { describe, expect, it } from "vitest";
import {
  evaluateAgentInvokability,
  listInvalidOrgChainDescendantIds,
  type AgentOrgRow,
} from "../services/agent-invokability.ts";

function agent(partial: Partial<AgentOrgRow> & Pick<AgentOrgRow, "id">): AgentOrgRow {
  return {
    companyId: "company-1",
    name: partial.id,
    reportsTo: null,
    status: "active",
    rosterKind: null,
    ...partial,
  };
}

describe("agent invokability", () => {
  it("blocks a fixture agent whose lifecycle state is otherwise perfectly healthy", () => {
    // The whole point of the roster_kind column: status says "active", the org
    // chain is clean, and it still must not be invoked for real work.
    const rows = [agent({ id: "loop-probe", rosterKind: "fixture" })];

    expect(evaluateAgentInvokability(rows[0], rows)).toMatchObject({
      invokable: false,
      reason: "fixture",
      invalidOrgChain: false,
      details: { agentId: "loop-probe", rosterKind: "fixture" },
    });
  });

  it("leaves undeclared and staff agents invokable", () => {
    // Null is UNDECLARED, not "fixture" — existing rows keep working.
    const undeclared = [agent({ id: "legacy" })];
    const staff = [agent({ id: "worker", rosterKind: "staff" })];

    expect(evaluateAgentInvokability(undeclared[0], undeclared)).toEqual({ invokable: true });
    expect(evaluateAgentInvokability(staff[0], staff)).toEqual({ invokable: true });
  });

  it("blocks active descendants under a terminated manager as invalid-org-chain", () => {
    const rows = [
      agent({ id: "ceo", status: "terminated" }),
      agent({ id: "cto", reportsTo: "ceo" }),
      agent({ id: "coder", reportsTo: "cto" }),
    ];

    const result = evaluateAgentInvokability(rows[2], rows);

    expect(result).toMatchObject({
      invokable: false,
      reason: "manager_terminated",
      invalidOrgChain: true,
      details: {
        managerId: "ceo",
        reportingChainAgentIds: ["cto", "ceo"],
      },
    });
  });

  it("reports missing managers and cycles as invalid-org-chain", () => {
    const missingManager = [agent({ id: "coder", reportsTo: "missing" })];
    expect(evaluateAgentInvokability(missingManager[0], missingManager)).toMatchObject({
      invokable: false,
      reason: "manager_missing",
      invalidOrgChain: true,
    });

    const cycle = [
      agent({ id: "a", reportsTo: "b" }),
      agent({ id: "b", reportsTo: "a" }),
    ];
    expect(evaluateAgentInvokability(cycle[0], cycle)).toMatchObject({
      invokable: false,
      reason: "reporting_cycle",
      invalidOrgChain: true,
    });
  });

  it("lists non-terminated descendants made invalid by a terminated root", () => {
    const rows = [
      agent({ id: "ceo", status: "terminated" }),
      agent({ id: "cto", reportsTo: "ceo" }),
      agent({ id: "coder", reportsTo: "cto" }),
      agent({ id: "old-coder", reportsTo: "cto", status: "terminated" }),
      agent({ id: "other-root" }),
    ];

    expect(listInvalidOrgChainDescendantIds("ceo", rows).sort()).toEqual(["coder", "cto"]);
  });
});
