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
  ProjectInventory,
  ProjectServices,
  ResourceHealth,
} from "@paperclipai/shared";
import { companyGcpProjects } from "./company-projects.js";
import { ApexUnavailableError, CliApexInvoker, type ApexInvoker } from "../apex/invoke.js";

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
        out.push({
          projectId: project,
          totalResources: res.total_resources ?? null,
          resourceTypes: res.resource_types ?? null,
          resourcesByType: res.resources_by_type ?? {},
          attributionSummary: res.attribution_summary,
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
