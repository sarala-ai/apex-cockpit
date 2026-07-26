/**
 * CloudTraceObserveStore — the product-agent plane of Observe.
 *
 * Reads DEPLOYED agent workloads (Cloud Run services) for a company by calling the
 * APEX `gcp_observability` resource server (released in apex-core 0.4.3) through
 * CliApexInvoker, scoped to the company's GCP projects (from cloud_scope_bindings).
 * Maps `list_agent_services` → FleetEntry (agentKind: "product").
 *
 * Honest scope: this gives the product plane at FLEET + health grain now. Product
 * runs/traces/evals need per-product OTel emission (#7) — a Cloud Run service isn't
 * a "run" until its agent emits spans — so those return empty here and the composite
 * falls back to the coding plane for them.
 *
 * Fully optional: if the `apex` CLI isn't installed (ApexUnavailableError) the plane
 * is silently empty, so Observe still works with just the coding plane.
 */
import { z } from "zod";
import { type Db } from "@paperclipai/db";
import { companyGcpProjects } from "./company-projects.js";
import type { ObserveStore } from "./tools.js";
import { observeInputs } from "./tools.js";
import type {
  AgentRun,
  EvalRecord,
  FleetEntry,
  FleetHealth,
  GcpServiceHealth,
  HealthSummary,
  RunDetail,
  Regression,
  ServiceLogEntry,
} from "./contract.js";
import { ApexUnavailableError, CliApexInvoker, type ApexInvoker } from "../apex/invoke.js";

// Shape returned by `apex run observability list-agent-services` (subset we use).
const ServiceSchema = z.object({
  name: z.string().nullable(),
  region: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  ready: z.boolean(),
  latest_ready_revision: z.string().nullable().optional(),
});
const ListServicesSchema = z.object({
  status: z.string().optional(),
  services: z.array(ServiceSchema),
});

// Shape returned by `apex run observability get-service-health` (subset). The CLI
// nests condition rows under `conditions`; each condition's fields are best-effort
// (the exact GCP shape varies), so everything but presence is nullable/optional.
const HealthConditionSchema = z.object({
  type: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
});
const ServiceHealthSchema = z.object({
  health: z.string(),
  ready: z.boolean(),
  url: z.string().nullable().optional(),
  latest_ready_revision: z.string().nullable().optional(),
  conditions: z.array(HealthConditionSchema).optional(),
});

// Shape returned by `apex run observability read-service-logs`. Cloud Logging
// entries; some carry trace/span ids. Kept permissive: keys the CLI may or may
// not include per entry.
const LogEntrySchema = z.object({
  timestamp: z.string().nullable().optional(),
  severity: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  traceId: z.string().nullable().optional(),
  trace_id: z.string().nullable().optional(),
  trace: z.string().nullable().optional(),
});
const ReadLogsSchema = z.object({
  status: z.string().optional(),
  entries: z.array(LogEntrySchema).optional(),
  logs: z.array(LogEntrySchema).optional(),
});

/** Cloud Logging returns `trace` as `projects/<p>/traces/<id>`; extract the bare id
 *  so it matches the bare trace ids app spans carry (cross-plane correlation). */
function bareTraceId(trace: string | null | undefined): string | null {
  if (!trace) return null;
  const i = trace.lastIndexOf("/traces/");
  return i >= 0 ? trace.slice(i + "/traces/".length) : trace;
}

export class CloudTraceObserveStore implements ObserveStore {
  constructor(
    private readonly db: Db,
    private readonly invoker: ApexInvoker = new CliApexInvoker(),
  ) {}

  private async companyProjects(companyId?: string): Promise<string[]> {
    return companyGcpProjects(this.db, companyId);
  }

  async fleet(input: z.infer<typeof observeInputs.fleet>): Promise<FleetEntry[]> {
    const projects = await this.companyProjects(input.companyId);
    const out: FleetEntry[] = [];
    for (const project of projects) {
      let res: z.infer<typeof ListServicesSchema>;
      try {
        res = await this.invoker.invoke(
          "observability",
          "list_agent_services",
          { project_id: project },
          ListServicesSchema,
        );
      } catch (e) {
        // apex not installed → the whole product plane is unavailable; give up quietly.
        if (e instanceof ApexUnavailableError) return out;
        // one project failed (auth/perm) → skip it, keep the others.
        continue;
      }
      for (const svc of res.services) {
        const health: FleetHealth = svc.ready ? "ok" : "down";
        out.push({
          entryKind: "agent",
          agentKind: "product",
          companyId: input.companyId,
          projectId: project,
          displayName: svc.name ?? "service",
          health,
          lastRunAt: null,
          runs24h: 0,
          successRate: null,
          source: "gcp",
        });
      }
    }
    return out;
  }

  /**
   * Locate a service by name across a company's GCP projects, returning it plus
   * the project + region it lives in — needed because get-service-health is
   * region-scoped and read-service-logs is project-scoped. Returns null if the
   * company has no projects, apex is unavailable, or no project holds the service.
   * Never throws (per-project failures are skipped).
   */
  private async locateService(
    companyId: string | undefined,
    service: string,
  ): Promise<{ project: string; region: string | null; url: string | null; ready: boolean } | null> {
    const projects = await this.companyProjects(companyId);
    for (const project of projects) {
      let res: z.infer<typeof ListServicesSchema>;
      try {
        res = await this.invoker.invoke(
          "observability",
          "list_agent_services",
          { project_id: project },
          ListServicesSchema,
        );
      } catch (e) {
        if (e instanceof ApexUnavailableError) return null;
        continue;
      }
      const svc = res.services.find((s) => s.name === service);
      if (svc) {
        return {
          project,
          region: svc.region ?? null,
          url: svc.url ?? null,
          ready: svc.ready,
        };
      }
    }
    return null;
  }

  /**
   * Live GCP resource health for one Cloud Run service (a product agent). Resolves
   * the service's project+region from the fleet listing, then calls
   * get-service-health. Returns null (graceful) if the service can't be located or
   * apex is unavailable; per-call failures never propagate.
   */
  async serviceHealth(companyId: string | undefined, service: string): Promise<GcpServiceHealth | null> {
    const located = await this.locateService(companyId, service);
    if (!located || !located.region) return null;
    let res: z.infer<typeof ServiceHealthSchema>;
    try {
      res = await this.invoker.invoke(
        "observability",
        "get_service_health",
        { project_id: located.project, region: located.region, service },
        ServiceHealthSchema,
      );
    } catch {
      return null;
    }
    return {
      service,
      health: res.health,
      ready: res.ready,
      url: res.url ?? located.url,
      revision: res.latest_ready_revision ?? null,
      conditions: (res.conditions ?? []).map((c) => ({
        type: c.type ?? null,
        status: c.status ?? null,
        message: c.message ?? null,
      })),
    };
  }

  /**
   * Recent Cloud Logging entries for one Cloud Run service, mapped to
   * ServiceLogEntry (timestamp/severity/message/traceId). Failure-isolated: apex
   * down / no such service → empty list, never throws.
   */
  async serviceLogs(
    companyId: string | undefined,
    service: string,
    limit = 50,
  ): Promise<ServiceLogEntry[]> {
    const project = (await this.locateService(companyId, service))?.project;
    if (!project) return [];
    let res: z.infer<typeof ReadLogsSchema>;
    try {
      res = await this.invoker.invoke(
        "observability",
        "read_service_logs",
        { project_id: project, service, limit },
        ReadLogsSchema,
      );
    } catch {
      return [];
    }
    const rows = res.entries ?? res.logs ?? [];
    return rows.map((r) => ({
      timestamp: r.timestamp ?? null,
      severity: r.severity ?? null,
      message: r.message ?? null,
      // Cloud Logging's `trace` is a full path `projects/<p>/traces/<id>`; app
      // spans carry the BARE id, so extract it for cross-plane correlation.
      traceId: bareTraceId(r.traceId ?? r.trace_id ?? r.trace ?? null),
    }));
  }

  // Product-plane runs/traces/evals require OTel emission (#7) — empty until then.
  async runs(): Promise<AgentRun[]> {
    return [];
  }
  async runDetail(): Promise<RunDetail | null> {
    return null;
  }
  async evals(): Promise<EvalRecord[]> {
    return [];
  }
  async regressions(): Promise<Regression[]> {
    return [];
  }
  async health(input: z.infer<typeof observeInputs.health>): Promise<HealthSummary> {
    // No run-level data yet; a zeroed summary so the composite's coding-plane
    // health isn't diluted.
    return {
      companyId: input.companyId,
      window: `${input.windowHours}h`,
      total: 0,
      succeeded: 0,
      failed: 0,
      running: 0,
      other: 0,
      successRate: null,
      avgDurationMs: null,
      totalCostUsd: 0,
      evalPassRate: null,
    };
  }
}
