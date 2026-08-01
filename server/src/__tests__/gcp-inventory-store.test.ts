import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { ApexInvoker } from "../apex/invoke.js";
import { GcpInventoryStore } from "../observe/gcp-inventory-store.js";

vi.mock("../observe/company-projects.js", () => ({
  companyGcpProjects: vi.fn(async () => ["proj-1"]),
}));

// resource-attribution-mapping (b5ffc436e) layers db-backed manual/auto_mapped
// rows onto the core payload's attribution. No db rows are under test here —
// only the passthrough of apex-core's own label/registry/exception
// classification — so this returns an empty map rather than hitting `db`.
vi.mock("../observe/resource-attribution-store.js", () => ({
  getAttributionsForProject: vi.fn(async () => new Map()),
}));

function invokerReturning(result: unknown): ApexInvoker {
  return { invoke: vi.fn(async () => result) };
}

/**
 * Provenance-at-birth (spec: provenance-at-birth, T5→T6): `list_project_resources`
 * gains an optional per-resource `attribution` and listing-level
 * `attribution_summary`. The store must pass both through untouched when
 * present, and must not choke (or invent them) when absent — older apex-core
 * builds never emit the fields.
 */
describe("GcpInventoryStore.listResources — attribution passthrough", () => {
  it("passes attribution and attributionSummary through when apex-core emits them", async () => {
    const invoker = invokerReturning({
      status: "success",
      project_id: "proj-1",
      total_resources: 2,
      resource_types: 1,
      resources_by_type: {
        "run.googleapis.com/Service": [
          { name: "svc-a", displayName: "svc-a", attribution: { status: "label", workflow: "deploy--v1" } },
          { name: "svc-b", displayName: "svc-b", attribution: { status: "exception" } },
        ],
      },
      attribution_summary: { label: 1, registry: 0, exception: 1 },
    });
    const store = new GcpInventoryStore({} as Db, invoker);

    const [inv] = await store.listResources("company-1");

    // mergeAttributions (b5ffc436e) always returns the full summary shape
    // (db-backed manual/auto_mapped/conflict counters alongside apex-core's
    // own label/registry/exception counts), all zero here since no db rows
    // are mocked in.
    expect(inv.attributionSummary).toEqual({
      label: 1,
      registry: 0,
      inherited: 0,
      system: 0,
      exception: 1,
      mapped: 0,
      manual: 0,
      conflicts: 0,
    });
    const resources = inv.resourcesByType["run.googleapis.com/Service"];
    expect(resources[0].attribution).toEqual({
      status: "label",
      workflow: "deploy--v1",
      source: "label",
      conflict: false,
    });
    expect(resources[1].attribution).toEqual({ status: "exception" });
  });

  it("tolerates the fields being absent (older apex-core) without inventing them", async () => {
    const invoker = invokerReturning({
      status: "success",
      project_id: "proj-1",
      total_resources: 1,
      resource_types: 1,
      resources_by_type: {
        "run.googleapis.com/Service": [{ name: "svc-a", displayName: "svc-a" }],
      },
    });
    const store = new GcpInventoryStore({} as Db, invoker);

    const [inv] = await store.listResources("company-1");

    expect(inv.attributionSummary).toBeUndefined();
    expect(inv.resourcesByType["run.googleapis.com/Service"][0].attribution).toBeUndefined();
  });
});
