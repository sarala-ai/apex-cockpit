import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authUsers, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("user idp identity (migration 0181)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-user-idp-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function newUser(overrides: Partial<typeof authUsers.$inferInsert> = {}) {
    const now = new Date();
    const id = `user-${randomUUID()}`;
    return {
      id,
      name: id,
      email: `${id}@example.com`,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it("rejects a second user with the same (idp_issuer, idp_subject)", async () => {
    await db.insert(authUsers).values(newUser({ idpIssuer: "https://idp.example", idpSubject: "sub-1" }));
    await expect(
      db.insert(authUsers).values(newUser({ idpIssuer: "https://idp.example", idpSubject: "sub-1" })),
    ).rejects.toThrow();
  });

  it("allows the same subject under a different issuer", async () => {
    await db.insert(authUsers).values(newUser({ idpIssuer: "https://idp-a.example", idpSubject: "sub-1" }));
    await db.insert(authUsers).values(newUser({ idpIssuer: "https://idp-b.example", idpSubject: "sub-1" }));
    expect(await db.select().from(authUsers)).toHaveLength(2);
  });

  it("does not constrain rows where idp columns are null (partial index)", async () => {
    await db.insert(authUsers).values(newUser());
    await db.insert(authUsers).values(newUser());
    expect(await db.select().from(authUsers)).toHaveLength(2);
  });
});
