/**
 * The owner gate for destructive operations. `assertCompanyAccess` answers
 * "may this caller write here"; this answers "may this caller destroy this",
 * and the two must not be the same question.
 */
import { describe, expect, it } from "vitest";
import { assertCompanyOwner } from "../routes/authz.js";

function makeReq(actor: Express.Request["actor"], method = "POST") {
  return { method, actor } as Express.Request;
}

const boardActor = (
  role: string | null,
  status = "active",
): Express.Request["actor"] => ({
  type: "board",
  userId: "user-1",
  source: "session",
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: role, status }],
  isInstanceAdmin: false,
});

describe("assertCompanyOwner", () => {
  it("allows an owner", () => {
    expect(() => assertCompanyOwner(makeReq(boardActor("owner")), "company-1")).not.toThrow();
  });

  it("allows an admin", () => {
    expect(() => assertCompanyOwner(makeReq(boardActor("admin")), "company-1")).not.toThrow();
  });

  it("rejects an operator — write access is not destroy access", () => {
    expect(() => assertCompanyOwner(makeReq(boardActor("operator")), "company-1")).toThrow(
      "Company owner or admin access required",
    );
  });

  it("rejects a viewer", () => {
    expect(() => assertCompanyOwner(makeReq(boardActor("viewer")), "company-1")).toThrow();
  });

  it("rejects a membership that is not active", () => {
    // Rejected by the inherited company-access check before the role check
    // even runs — which is the point: the owner gate is strictly narrower.
    expect(() => assertCompanyOwner(makeReq(boardActor("owner", "pending")), "company-1")).toThrow(
      "User does not have active company access",
    );
  });

  it("rejects an owner of a DIFFERENT company", () => {
    expect(() => assertCompanyOwner(makeReq(boardActor("owner")), "company-2")).toThrow();
  });

  it("rejects an agent even for its own company", () => {
    const agent = makeReq({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      onBehalfOfUserId: "user-1",
      onBehalfOfMemberships: [
        { companyId: "company-1", membershipRole: "owner", status: "active" },
      ],
    } as Express.Request["actor"]);
    expect(() => assertCompanyOwner(agent, "company-1")).toThrow("Board access required");
  });

  it("rejects an unauthenticated caller", () => {
    expect(() => assertCompanyOwner(makeReq({ type: "none", source: "none" }), "company-1")).toThrow();
  });

  it("allows an instance admin", () => {
    expect(() =>
      assertCompanyOwner(
        makeReq({
          type: "board",
          userId: "admin-1",
          source: "session",
          companyIds: ["company-1"],
          memberships: [],
          isInstanceAdmin: true,
        }),
        "company-1",
      ),
    ).not.toThrow();
  });

  it("allows the local trusted board", () => {
    expect(() =>
      assertCompanyOwner(
        makeReq({
          type: "board",
          userId: "local-board",
          source: "local_implicit",
          isInstanceAdmin: true,
        }),
        "company-1",
      ),
    ).not.toThrow();
  });
});
