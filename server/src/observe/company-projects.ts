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
