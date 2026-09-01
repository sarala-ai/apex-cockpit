import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, teamMemberships, teams } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  addTeamMember,
  createTeam,
  getTeam,
  listTeamMembers,
  listTeams,
  removeTeamMember,
} from "./teams.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("teams service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-teams-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(teamMemberships);
    await db.delete(teams);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    // issue_prefix has a unique index and defaults to "PAP", so give each
    // seeded company a distinct prefix.
    const prefix = randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase();
    const [company] = await db
      .insert(companies)
      .values({ name: `Co ${randomUUID()}`, issuePrefix: prefix })
      .returning();
    return company.id;
  }

  it("creates a team and lists it under its company", async () => {
    const companyId = await seedCompany();
    const team = await createTeam(db, { companyId, name: "Platform", slug: "platform" });

    expect(team).toMatchObject({ companyId, name: "Platform", slug: "platform" });

    const listed = await listTeams(db, companyId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(team.id);

    const fetched = await getTeam(db, team.id);
    expect(fetched?.id).toBe(team.id);
    expect(await getTeam(db, randomUUID())).toBeNull();
  });

  it("enforces slug uniqueness within a company but allows reuse across companies", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    await createTeam(db, { companyId: companyA, name: "Platform", slug: "platform" });
    await expect(
      createTeam(db, { companyId: companyA, name: "Platform 2", slug: "platform" }),
    ).rejects.toThrow();

    // Same slug is fine under a different company.
    const cross = await createTeam(db, { companyId: companyB, name: "Platform", slug: "platform" });
    expect(cross.companyId).toBe(companyB);
  });

  it("adds, lists, upserts, and removes members", async () => {
    const companyId = await seedCompany();
    const team = await createTeam(db, { companyId, name: "Eng", slug: "eng" });
    const userId = `user-${randomUUID()}`;

    const asMember = await addTeamMember(db, { teamId: team.id, userId });
    expect(asMember).toMatchObject({ teamId: team.id, userId, role: "member" });

    // Re-adding upserts (no duplicate row) and updates the role.
    const asLead = await addTeamMember(db, { teamId: team.id, userId, role: "lead" });
    expect(asLead.role).toBe("lead");

    const members = await listTeamMembers(db, team.id);
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe("lead");

    await removeTeamMember(db, { teamId: team.id, userId });
    expect(await listTeamMembers(db, team.id)).toHaveLength(0);
  });
});
