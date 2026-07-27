/**
 * Shared helper: resolve a company's bound GCP project IDs (from
 * cloud_scope_bindings, set via the Setup wizard's cloud binding). Used by every
 * GCP-backed observe plane (Cloud Run fleet/health, and the broader resource
 * inventory) so the scoping logic lives in one place.
 */
import { and, eq } from "drizzle-orm";
import { type Db, cloudScopeBindings } from "@paperclipai/db";

export async function companyGcpProjects(db: Db, companyId?: string): Promise<string[]> {
  if (!companyId) return [];
  const rows = await db
    .select({ gcpProjects: cloudScopeBindings.gcpProjects })
    .from(cloudScopeBindings)
    .where(and(eq(cloudScopeBindings.scopeType, "company"), eq(cloudScopeBindings.scopeId, companyId)))
    .limit(1);
  return rows[0]?.gcpProjects ?? [];
}

/** A company's bound GitHub repos ("owner/name") — same binding row, other
 *  column. Used by the Design surface to discover design-as-code files across
 *  bound repos (placement-agnostic: a standalone design repo or an in-repo
 *  design/ dir are both just bindings — see the design-placement principle). */
export async function companyGithubRepos(db: Db, companyId?: string): Promise<string[]> {
  if (!companyId) return [];
  const rows = await db
    .select({ githubRepos: cloudScopeBindings.githubRepos })
    .from(cloudScopeBindings)
    .where(and(eq(cloudScopeBindings.scopeType, "company"), eq(cloudScopeBindings.scopeId, companyId)))
    .limit(1);
  return rows[0]?.githubRepos ?? [];
}
