import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { runIntakeCheck } from "./issue-intake.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue-intake integration tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("findDuplicates — real Postgres", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-intake-");
    db = createDb(tempDb.connectionString);

    const [company] = await db
      .insert(companies)
      .values({ name: "Intake Test Co", issuePrefix: "INT" })
      .returning();
    companyId = company.id;

    // Insert test issues: two with overlapping keywords, one unrelated
    await db.insert(issues).values([
      {
        companyId,
        title: "Fix the authentication login button",
        status: "todo",
        identifier: "INT-1",
      },
      {
        companyId,
        title: "Update login button styling",
        status: "backlog",
        identifier: "INT-2",
      },
      {
        companyId,
        title: "Refactor database migrations pipeline",
        status: "todo",
        identifier: "INT-3",
      },
    ]);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("executes the scoring query without SQL errors on real Postgres", async () => {
    // Would throw if the SQL uses an unresolvable alias in ORDER BY
    await expect(
      runIntakeCheck(db, companyId, "Fix login authentication", {}),
    ).resolves.toBeDefined();
  });

  it("surfaces issues with sufficient keyword overlap as duplicates", async () => {
    const result = await runIntakeCheck(db, companyId, "Fix the login button", {});
    const dupIds = result.duplicates.map((d) => d.identifier);
    // Both INT-1 and INT-2 share multiple keywords with the query title
    expect(dupIds).toContain("INT-1");
    expect(dupIds).toContain("INT-2");
    // INT-3 shares no relevant keywords
    expect(dupIds).not.toContain("INT-3");
  });

  it("returns duplicates ordered by match count — higher match first", async () => {
    const result = await runIntakeCheck(db, companyId, "Fix the authentication login button", {});
    const dupIds = result.duplicates.map((d) => d.identifier);
    // INT-1 matches more keywords than INT-2; it must appear first
    expect(dupIds.indexOf("INT-1")).toBeLessThan(dupIds.indexOf("INT-2"));
  });

  it("returns empty duplicates when no issues share sufficient keywords", async () => {
    const result = await runIntakeCheck(db, companyId, "Onboard new enterprise customer", {});
    expect(result.duplicates).toHaveLength(0);
  });
});
