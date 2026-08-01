/**
 * Resource-attribution mapping (spec: resource-attribution-mapping) —
 * durable, correctable ownership records for GCP resources, layered under
 * GcpInventoryStore's live label/registry/exception classification.
 *
 * Precedence (enforced in gcp-inventory-store's merge, not here):
 *   manual (this table, source='manual') > cloud label (from apex-core, live)
 *   > auto_mapped (this table, source='auto_mapped') > whatever core said.
 *
 * Two writers:
 *   - `importMapperReport` — bulk-loads apex-core's `resource-mapper` report's
 *     `exact` section as `auto_mapped` rows. Idempotent on (projectId,
 *     resourceUri): re-importing updates in place, and never clobbers a row a
 *     human has since promoted to `manual` (conflict resolver wins).
 *   - `upsertManualAttribution` — one human decision, always wins outright.
 *
 * `projectId` here is the GCP project id string (e.g. "finpilot-dev"), not a
 * FK to the cockpit `projects` table — see resource_attributions.ts.
 */
import { and, eq } from "drizzle-orm";
import { type Db, resourceAttributions } from "@paperclipai/db";

export type ResourceAttributionRow = typeof resourceAttributions.$inferSelect;

// Best-effort Cloud Asset Inventory–style `service/Kind` label, derived from a
// full resource name (e.g. "//storage.googleapis.com/finpilot-dev-uploads" →
// "storage.googleapis.com/Bucket"). Never authoritative — just what's shown in
// the UI/API for a row; matching against live inventory is always by
// `resourceUri`, never by this field. Falls back to the bare service host for
// anything not in the table.
const SERVICE_KIND: Record<string, string> = {
  "storage.googleapis.com": "Bucket",
  "secretmanager.googleapis.com": "Secret",
  "artifactregistry.googleapis.com": "Repository",
  "run.googleapis.com": "Service",
  "firestore.googleapis.com": "Database",
  "iam.googleapis.com": "ServiceAccount",
  "sqladmin.googleapis.com": "CloudSqlInstance",
};

export function deriveAssetType(resourceUri: string): string {
  const match = resourceUri.match(/^\/\/([^/]+)\//);
  const host = match?.[1] ?? resourceUri;
  const kind = SERVICE_KIND[host];
  return kind ? `${host}/${kind}` : host;
}

function parseEvidence(value: string | undefined): { file: string; line: number | null } | null {
  if (!value) return null;
  const idx = value.lastIndexOf(":");
  if (idx === -1) return { file: value, line: null };
  const file = value.slice(0, idx);
  const lineNum = Number(value.slice(idx + 1));
  return { file, line: Number.isFinite(lineNum) ? lineNum : null };
}

// Shape of one entry in a `resource-mapper` report's `exact` array. Kept
// permissive/optional throughout — same defensive posture as the rest of
// observe's apex-core passthroughs.
export type MapperExactEntry = {
  resource?: {
    name?: string | null;
    attribution?: { env?: string | null } | null;
  } | null;
  workflow?: string | null;
  workflow_path?: string | null;
  repo?: string | null;
  step_name?: string | null;
  inputs?: Record<string, unknown> | null;
  evidence?: string | null;
};

export type MapperReport = {
  exact?: MapperExactEntry[];
  // proposals/drift/untouched are deliberately NOT imported (spec: only exact
  // mappings are auto_mapped; anything less certain needs human review first).
  [key: string]: unknown;
};

export type ImportResult = {
  imported: number;
  updated: number;
  skippedManual: number;
  skippedNoResource: number;
};

export async function importMapperReport(
  db: Db,
  companyId: string,
  projectId: string,
  report: MapperReport,
): Promise<ImportResult> {
  const entries = Array.isArray(report.exact) ? report.exact : [];
  const result: ImportResult = { imported: 0, updated: 0, skippedManual: 0, skippedNoResource: 0 };

  for (const entry of entries) {
    const resourceUri = entry.resource?.name;
    if (!resourceUri) {
      result.skippedNoResource += 1;
      continue;
    }

    const existing = await db
      .select({ id: resourceAttributions.id, source: resourceAttributions.source })
      .from(resourceAttributions)
      .where(
        and(eq(resourceAttributions.projectId, projectId), eq(resourceAttributions.resourceUri, resourceUri)),
      )
      .limit(1);

    if (existing[0]?.source === "manual") {
      // A human already made a call on this resource — never overwrite it
      // with a re-import of the (necessarily lower-precedence) auto mapping.
      result.skippedManual += 1;
      continue;
    }

    const env = (entry.inputs?.environment as string | undefined) ?? entry.resource?.attribution?.env ?? null;
    const values = {
      companyId,
      projectId,
      resourceUri,
      assetType: deriveAssetType(resourceUri),
      source: "auto_mapped" as const,
      workflow: entry.workflow ?? null,
      repo: entry.repo ?? null,
      env,
      confidence: "exact" as const,
      evidence: {
        ...parseEvidence(entry.evidence ?? undefined),
        workflowFile: entry.workflow_path ?? null,
        stepName: entry.step_name ?? null,
        inputs: entry.inputs ?? null,
      },
      updatedAt: new Date(),
    };

    if (existing[0]) {
      await db
        .update(resourceAttributions)
        .set(values)
        .where(eq(resourceAttributions.id, existing[0].id));
      result.updated += 1;
    } else {
      await db.insert(resourceAttributions).values(values);
      result.imported += 1;
    }
  }

  return result;
}

export type ManualAttributionInput = {
  companyId: string;
  projectId: string;
  resourceUri: string;
  assetType: string;
  workflow?: string | null;
  repo?: string | null;
  env?: string | null;
  decidedBy: string | null;
};

export async function upsertManualAttribution(
  db: Db,
  input: ManualAttributionInput,
): Promise<ResourceAttributionRow> {
  const existing = await db
    .select({ id: resourceAttributions.id })
    .from(resourceAttributions)
    .where(
      and(
        eq(resourceAttributions.projectId, input.projectId),
        eq(resourceAttributions.resourceUri, input.resourceUri),
      ),
    )
    .limit(1);

  const values = {
    companyId: input.companyId,
    projectId: input.projectId,
    resourceUri: input.resourceUri,
    assetType: input.assetType,
    source: "manual" as const,
    workflow: input.workflow ?? null,
    repo: input.repo ?? null,
    env: input.env ?? null,
    confidence: null,
    decidedBy: input.decidedBy,
    updatedAt: new Date(),
  };

  if (existing[0]) {
    const [row] = await db
      .update(resourceAttributions)
      .set(values)
      .where(eq(resourceAttributions.id, existing[0].id))
      .returning();
    return row;
  }
  const [row] = await db.insert(resourceAttributions).values(values).returning();
  return row;
}

export async function getAttributionsForProject(
  db: Db,
  companyId: string,
  projectId: string,
): Promise<Map<string, ResourceAttributionRow>> {
  const rows = await db
    .select()
    .from(resourceAttributions)
    .where(and(eq(resourceAttributions.companyId, companyId), eq(resourceAttributions.projectId, projectId)));
  return new Map(rows.map((r) => [r.resourceUri, r]));
}

/**
 * The footprint join for the Workflows detail route: every resource this
 * cockpit's `resource_attributions` table has recorded against a given
 * workflow name, ACROSS companies (a workflow name isn't company-scoped —
 * it's whatever the CLI attributed, manual or auto_mapped). Deliberately NOT
 * a live cloud query — see the `note` the route attaches alongside this, this
 * is db-known attribution only.
 */
export async function getAttributionsByWorkflow(db: Db, workflow: string): Promise<ResourceAttributionRow[]> {
  return db.select().from(resourceAttributions).where(eq(resourceAttributions.workflow, workflow));
}
