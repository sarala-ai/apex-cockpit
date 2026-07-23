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
import { and, eq } from "drizzle-orm";
import { type Db, cloudScopeBindings } from "@paperclipai/db";
import type { ObserveStore } from "./tools.js";
import { observeInputs } from "./tools.js";
import type {
  AgentRun,
  EvalRecord,
  FleetEntry,
  FleetHealth,
  HealthSummary,
  RunDetail,
  Regression,
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

export class CloudTraceObserveStore implements ObserveStore {
  constructor(
    private readonly db: Db,
    private readonly invoker: ApexInvoker = new CliApexInvoker(),
  ) {}

  private async companyProjects(companyId?: string): Promise<string[]> {
    if (!companyId) return [];
    const rows = await this.db
      .select({ gcpProjects: cloudScopeBindings.gcpProjects })
      .from(cloudScopeBindings)
      .where(and(eq(cloudScopeBindings.scopeType, "company"), eq(cloudScopeBindings.scopeId, companyId)))
      .limit(1);
    return rows[0]?.gcpProjects ?? [];
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
