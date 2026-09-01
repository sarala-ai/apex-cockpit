import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { teamMemberships, teams } from "@paperclipai/db";

export type TeamRole = "lead" | "member";

export interface CreateTeamInput {
  companyId: string;
  name: string;
  slug: string;
}

export interface AddTeamMemberInput {
  teamId: string;
  userId: string;
  role?: TeamRole;
}

export async function createTeam(db: Db, input: CreateTeamInput) {
  const [row] = await db
    .insert(teams)
    .values({ companyId: input.companyId, name: input.name, slug: input.slug })
    .returning();
  return row;
}

export async function listTeams(db: Db, companyId: string) {
  return db.select().from(teams).where(eq(teams.companyId, companyId));
}

export async function getTeam(db: Db, teamId: string) {
  return db
    .select()
    .from(teams)
    .where(eq(teams.id, teamId))
    .then((rows) => rows[0] ?? null);
}

// Upsert on (teamId, userId): re-adding a member updates their role rather than
// erroring, mirroring the company_memberships onConflictDoUpdate convention.
export async function addTeamMember(db: Db, input: AddTeamMemberInput) {
  const role: TeamRole = input.role ?? "member";
  const [row] = await db
    .insert(teamMemberships)
    .values({ teamId: input.teamId, userId: input.userId, role })
    .onConflictDoUpdate({
      target: [teamMemberships.teamId, teamMemberships.userId],
      set: { role, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function removeTeamMember(db: Db, input: { teamId: string; userId: string }) {
  await db
    .delete(teamMemberships)
    .where(and(eq(teamMemberships.teamId, input.teamId), eq(teamMemberships.userId, input.userId)));
}

export async function listTeamMembers(db: Db, teamId: string) {
  return db.select().from(teamMemberships).where(eq(teamMemberships.teamId, teamId));
}
