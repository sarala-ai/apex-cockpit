import { describe, expect, it } from "vitest";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { InProcessAuthClient } from "./auth-client.js";
import type { BetterAuthSessionResult } from "./better-auth.js";

// Minimal fake Drizzle Db supporting the two select chains resolveHuman uses:
//   select().from(instanceUserRoles).where().then(rows => rows[0])   (admin lookup)
//   select().from(companyMemberships).where()                         (memberships)
// The .where() result is thenable so both awaited and .then()-chained call
// shapes resolve to the table-appropriate rows.
function createFakeDb(rows: { adminRows: unknown[]; membershipRows: unknown[] }) {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const result =
          table === instanceUserRoles
            ? rows.adminRows
            : table === companyMemberships
              ? rows.membershipRows
              : [];
        return {
          where: () => ({
            then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
          }),
        };
      },
    }),
  } as unknown as Db;
  return db;
}

const fakeReq = { method: "GET", originalUrl: "/x", header: () => undefined } as unknown as Request;

const SESSION: BetterAuthSessionResult = {
  session: { id: "sess-1", userId: "user-1" },
  user: { id: "user-1", email: "a@b.com", name: "Ada" },
};

describe("InProcessAuthClient.resolveHuman", () => {
  it("maps a session + tenancy rows into a HumanIdentity", async () => {
    const db = createFakeDb({
      adminRows: [{ id: "role-1" }],
      membershipRows: [{ companyId: "c1", membershipRole: "owner", status: "active" }],
    });
    const client = new InProcessAuthClient(db, async () => SESSION);
    const human = await client.resolveHuman(fakeReq);
    expect(human).toEqual({
      userId: "user-1",
      userName: "Ada",
      userEmail: "a@b.com",
      companyIds: ["c1"],
      memberships: [{ companyId: "c1", membershipRole: "owner", status: "active" }],
      isInstanceAdmin: true,
    });
  });

  it("returns isInstanceAdmin=false when no admin role row exists", async () => {
    const db = createFakeDb({ adminRows: [], membershipRows: [] });
    const client = new InProcessAuthClient(db, async () => SESSION);
    const human = await client.resolveHuman(fakeReq);
    expect(human?.isInstanceAdmin).toBe(false);
    expect(human?.companyIds).toEqual([]);
  });

  it("returns null when there is no session/user", async () => {
    const db = createFakeDb({ adminRows: [], membershipRows: [] });
    const client = new InProcessAuthClient(db, async () => null);
    expect(await client.resolveHuman(fakeReq)).toBeNull();
  });

  it("returns null (and swallows) when session resolution throws", async () => {
    const db = createFakeDb({ adminRows: [], membershipRows: [] });
    const client = new InProcessAuthClient(db, async () => {
      throw new Error("boom");
    });
    expect(await client.resolveHuman(fakeReq)).toBeNull();
  });
});
