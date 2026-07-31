/**
 * GcpInventoryStore — full project resource inventory (beyond Cloud Run).
 *
 * Reads a company's bound GCP projects (same `cloud_scope_bindings` scoping as
 * CloudTraceObserveStore) and calls the APEX `gcp_inventory` resource server
 * (list_project_resources / list_project_services / get_resource_health)
 * through CliApexInvoker. This is a raw resource inventory, not agent-run
 * observability — deliberately NOT part of ObserveStore/CompositeObserveStore,
 * same reason the Ops (APEX/CI run) surface is a separate small route: no
 * shared contract shape to force it into.
 *
 * Failure-isolated per project: a project with no gcp_inventory access (auth,
 * API not enabled, etc.) reports its own error and doesn't take down the rest.
 */
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type {
  AttributionConflict,
  ProjectInventory,
  ProjectServices,
  ResourceHealth,
} from "@paperclipai/shared";
import { companyGcpProjects } from "./company-projects.js";
import { ApexUnavailableError, CliApexInvoker, type ApexInvoker } from "../apex/invoke.js";
import { getAttributionsForProject, type ResourceAttributionRow } from "./resource-attribution-store.js";

// Provenance-at-birth (spec: provenance-at-birth) — attribution classification
// emitted per-resource by `gcp_inventory.list_project_resources` on apex-core
// builds that support it (T5). Optional throughout: absent on older cores,
// and the listing must still render exactly as before in that case.
const AttributionSchema = z.object({
  status: z.enum(["label", "registry", "exception"]),
  workflow: z.string().nullable().optional(),
  repo: z.string().nullable().optional(),
  env: z.string().nullable().optional(),
});

const ResourceSchema = z.object({
  name: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  createTime: z.string().nullable().optional(),
  updateTime: z.string().nullable().optional(),
  attribution: AttributionSchema.optional(),
});

const AttributionSummarySchema = z.object({
  label: z.number(),
  registry: z.number(),
  exception: z.number(),
});

// Shape returned by `apex run inventory list-project-resources`.
const ListResourcesSchema = z.object({
  status: z.string().optional(),
  project_id: z.string().optional(),
  total_resources: z.number().nullable().optional(),
  resource_types: z.number().nullable().optional(),
  resources_by_type: z.record(z.string(), z.array(ResourceSchema)).optional(),
  attribution_summary: AttributionSummarySchema.optional(),
  error: z.string().optional(),
});

// Shape returned by `apex run inventory list-project-services` (grouped,
// snake_case service keys per gcp_inventory.py's `services` dict).
const ListServicesSchema = z.object({
  status: z.string().optional(),
  project_id: z.string().optional(),
  services: z
    .object({
      cloud_run: z.array(z.record(z.string(), z.unknown())).optional(),
      enabled_apis: z.array(z.string()).optional(),
      secrets: z.array(z.record(z.string(), z.unknown())).optional(),
      buckets: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .optional(),
  error: z.string().optional(),
});

const ResourceHealthResultSchema = z.object({
  resource_type: z.string().nullable().optional(),
  resource_name: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  ready: z.boolean().nullable().optional(),
  url: z.string().nullable().optional(),
  details: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.string().nullable().optional(),
});

function attributionsDisagree(
  label: { workflow?: string | null; repo?: string | null; env?: string | null },
  row: ResourceAttributionRow,
): boolean {
  // Compare through the SAME sanitization the engine applies when it writes
  // cloud labels (apex-core provenance.sanitize_label_value): lowercase,
  // "/"→"--", any other invalid char→"_". Mapper reports carry raw values
  // ("sarala-ai/FinPilot"); labels carry sanitized ones ("sarala-ai--finpilot").
  // Comparing raw-vs-sanitized false-conflicted every agreeing mapping — a
  // conflict must mean the IDENTITY disagrees, never the encoding.
  const norm = (v: string | null | undefined) => {
    if (v == null || v === "") return null;
    return v.toLowerCase().replaceAll("/", "--").replace(/[^a-z0-9_-]/g, "_");
  };
  return (
    norm(label.workflow) !== norm(row.workflow) ||
    norm(label.repo) !== norm(row.repo) ||
    norm(label.env) !== norm(row.env)
  );
}

// Precedence merge (spec: resource-attribution-mapping) — overlays this
// company/project's `resource_attributions` db rows onto the core payload's
// per-resource attribution. Precedence: manual (db) > cloud label (core,
// live) > auto_mapped (db) > whatever core said (registry/exception, or
// nothing on cores that don't emit attribution at all). Mutates nothing —
// returns a new resourcesByType map plus a recomputed summary so the two
// never drift apart.
export function mergeAttributions(
  resourcesByType: ProjectInventory["resourcesByType"],
  dbRows: Map<string, ResourceAttributionRow>,
): { resourcesByType: ProjectInventory["resourcesByType"]; summary: NonNullable<ProjectInventory["attributionSummary"]> } {
  const summary = { label: 0, registry: 0, exception: 0, mapped: 0, manual: 0, conflicts: 0 };
  const out: ProjectInventory["resourcesByType"] = {};

  for (const [assetType, resources] of Object.entries(resourcesByType)) {
    out[assetType] = resources.map((resource) => {
      const uri = resource.name;
      const row = uri ? dbRows.get(uri) : undefined;
      const core = resource.attribution;

      if (row?.source === "manual") {
        summary.manual += 1;
        return {
          ...resource,
          attribution: { status: "manual" as const, workflow: row.workflow, repo: row.repo, env: row.env, source: "manual" as const },
        };
      }

      if (core?.status === "label") {
        const conflict = row?.source === "auto_mapped" ? attributionsDisagree(core, row) : false;
        if (conflict) summary.conflicts += 1;
        summary.label += 1;
        return {
          ...resource,
          attribution: { ...core, source: "label" as const, conflict },
        };
      }

      if (row?.source === "auto_mapped") {
        summary.mapped += 1;
        return {
          ...resource,
          attribution: {
            status: "mapped" as const,
            workflow: row.workflow,
            repo: row.repo,
            env: row.env,
            source: "auto_mapped" as const,
          },
        };
      }

      if (core?.status === "registry") summary.registry += 1;
      else if (core?.status === "exception") summary.exception += 1;
      return resource;
    });
  }

  return { resourcesByType: out, summary };
}

export class GcpInventoryStore {
  constructor(
    private readonly db: Db,
    // Cloud Asset Inventory queries are much slower than the run/health/log
    // reads the default 20s invoker timeout was sized for — a cold asset
    // index on a ~1200-resource project takes tens of seconds (verified live:
    // the 20s default killed real queries mid-flight, surfacing as
    // "failed (code null)"). 120s bounds the worst case; the store is
    // failure-isolated per project either way.
    private readonly invoker: ApexInvoker = new CliApexInvoker(undefined, 120_000),
  ) {}

  async listResources(companyId?: string): Promise<ProjectInventory[]> {
    const projects = await companyGcpProjects(this.db, companyId);
    const out: ProjectInventory[] = [];
    for (const project of projects) {
      try {
        const res = await this.invoker.invoke(
          "inventory",
          "list_project_resources",
          { project_id: project },
          ListResourcesSchema,
        );
        const resourcesByType = res.resources_by_type ?? {};
        const dbRows = companyId ? await getAttributionsForProject(this.db, companyId, project) : new Map();
        const merged = mergeAttributions(resourcesByType, dbRows);
        out.push({
          projectId: project,
          totalResources: res.total_resources ?? null,
          resourceTypes: res.resource_types ?? null,
          resourcesByType: merged.resourcesByType,
          attributionSummary: res.attribution_summary ? merged.summary : undefined,
          error: res.status === "success" ? null : (res.error ?? null),
        });
      } catch (e) {
        if (e instanceof ApexUnavailableError) return out;
        out.push({
          projectId: project,
          totalResources: null,
          resourceTypes: null,
          resourcesByType: {},
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return out;
  }

  async listServices(companyId?: string): Promise<ProjectServices[]> {
    const projects = await companyGcpProjects(this.db, companyId);
    const out: ProjectServices[] = [];
    for (const project of projects) {
      try {
        const res = await this.invoker.invoke(
          "inventory",
          "list_project_services",
          { project_id: project },
          ListServicesSchema,
        );
        out.push({
          projectId: project,
          cloudRun: res.services?.cloud_run,
          enabledApis: res.services?.enabled_apis,
          secrets: res.services?.secrets,
          buckets: res.services?.buckets,
          error: res.status === "success" || res.status === "partial" ? null : (res.error ?? null),
        });
      } catch (e) {
        if (e instanceof ApexUnavailableError) return out;
        out.push({ projectId: project, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  // GET /observe/attribution/conflicts — resources across this company's bound
  // projects where the live cloud label and the db's auto_mapped row disagree.
  // Reuses listResources' own merge (single source of truth for what counts as
  // a conflict) rather than recomputing it.
  async attributionConflicts(companyId: string): Promise<AttributionConflict[]> {
    const inventories = await this.listResources(companyId);
    const out: AttributionConflict[] = [];
    for (const inv of inventories) {
      // The disagreeing db side isn't carried on the merged resource (only the
      // winning label side is) — look the auto_mapped rows back up directly
      // for the "mapping says" half of each diff, once per project.
      const dbRows = await getAttributionsForProject(this.db, companyId, inv.projectId);
      for (const [assetType, resources] of Object.entries(inv.resourcesByType)) {
        for (const resource of resources) {
          if (!resource.attribution?.conflict || !resource.name) continue;
          const row = dbRows.get(resource.name);
          out.push({
            projectId: inv.projectId,
            resourceUri: resource.name,
            assetType,
            displayName: resource.displayName ?? null,
            label: {
              workflow: resource.attribution.workflow ?? null,
              repo: resource.attribution.repo ?? null,
              env: resource.attribution.env ?? null,
            },
            mapping: { workflow: row?.workflow ?? null, repo: row?.repo ?? null, env: row?.env ?? null },
          });
        }
      }
    }
    return out;
  }

  /** `_companyId` isn't used to scope the call yet (projectId is caller-supplied
   *  from a company-scoped inventory listing already), kept for a future
   *  authorization check that projectId actually belongs to companyId. */
  async resourceHealth(
    _companyId: string | undefined,
    projectId: string,
    resourceType: string,
    resourceName: string,
  ): Promise<ResourceHealth | null> {
    try {
      const res = await this.invoker.invoke(
        "inventory",
        "get_resource_health",
        { project_id: projectId, resource_type: resourceType, resource_name: resourceName },
        ResourceHealthResultSchema,
      );
      return {
        projectId,
        resourceType: res.resource_type ?? resourceType,
        resourceName: res.resource_name ?? resourceName,
        status: res.status ?? null,
        ready: res.ready ?? null,
        url: res.url ?? null,
        details: res.details ?? null,
        error: res.error ?? null,
      };
    } catch {
      return null;
    }
  }
}
