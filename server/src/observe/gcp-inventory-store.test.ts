import { describe, expect, it } from "vitest";
import type { ProjectInventory } from "@paperclipai/shared";
import { mergeAttributions } from "./gcp-inventory-store.js";
import type { ResourceAttributionRow } from "./resource-attribution-store.js";

// Precedence merge (spec: resource-attribution-mapping): manual (db) > cloud
// label (core, live) > auto_mapped (db) > whatever core said. Pure-function
// tests — no db, no apex CLI — the db-row inputs are hand-built rows.

function row(overrides: Partial<ResourceAttributionRow>): ResourceAttributionRow {
  return {
    id: "row-1",
    companyId: "co-1",
    projectId: "proj-1",
    resourceUri: "//storage.googleapis.com/bucket-a",
    assetType: "storage.googleapis.com/Bucket",
    source: "auto_mapped",
    workflow: "infra_workflow",
    repo: "org/repo",
    env: "dev",
    confidence: "exact",
    evidence: null,
    decidedBy: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as ResourceAttributionRow;
}

function resourcesByType(
  attribution: ProjectInventory["resourcesByType"][string][number]["attribution"],
  name = "//storage.googleapis.com/bucket-a",
): ProjectInventory["resourcesByType"] {
  return {
    "storage.googleapis.com/Bucket": [{ name, displayName: name.split("/").pop(), attribution }],
  };
}

describe("mergeAttributions", () => {
  it("manual db row wins outright, even when core reports a disagreeing label", () => {
    const dbRows = new Map([
      ["//storage.googleapis.com/bucket-a", row({ source: "manual", workflow: "manual_wf", repo: "org/manual-repo", env: "prod", decidedBy: "user-1" })],
    ]);
    const result = mergeAttributions(
      resourcesByType({ status: "label", workflow: "infra_workflow", repo: "org/repo", env: "dev" }),
      dbRows,
    );
    const resource = result.resourcesByType["storage.googleapis.com/Bucket"][0];
    expect(resource.attribution).toMatchObject({
      status: "manual",
      workflow: "manual_wf",
      repo: "org/manual-repo",
      env: "prod",
      source: "manual",
    });
    expect(result.summary).toMatchObject({ manual: 1, label: 0, mapped: 0, registry: 0, exception: 0, conflicts: 0 });
  });

  it("cloud label wins over an agreeing auto_mapped row, no conflict", () => {
    const dbRows = new Map([
      ["//storage.googleapis.com/bucket-a", row({ source: "auto_mapped" })],
    ]);
    const result = mergeAttributions(
      resourcesByType({ status: "label", workflow: "infra_workflow", repo: "org/repo", env: "dev" }),
      dbRows,
    );
    const resource = result.resourcesByType["storage.googleapis.com/Bucket"][0];
    expect(resource.attribution).toMatchObject({ status: "label", source: "label", conflict: false });
    expect(result.summary).toMatchObject({ label: 1, manual: 0, mapped: 0, conflicts: 0 });
  });

  it("flags a conflict when the cloud label and an auto_mapped row disagree, keeping label effective", () => {
    const dbRows = new Map([
      ["//storage.googleapis.com/bucket-a", row({ source: "auto_mapped", workflow: "mapped_wf", repo: "org/mapped-repo", env: "staging" })],
    ]);
    const result = mergeAttributions(
      resourcesByType({ status: "label", workflow: "infra_workflow", repo: "org/repo", env: "dev" }),
      dbRows,
    );
    const resource = result.resourcesByType["storage.googleapis.com/Bucket"][0];
    expect(resource.attribution).toMatchObject({
      status: "label",
      workflow: "infra_workflow", // label stays effective
      source: "label",
      conflict: true,
    });
    expect(result.summary).toMatchObject({ label: 1, conflicts: 1, mapped: 0, manual: 0 });
  });

  it("auto_mapped row is used when core has no label (registry/exception/absent)", () => {
    const dbRows = new Map([
      ["//storage.googleapis.com/bucket-a", row({ source: "auto_mapped", workflow: "infra_workflow" })],
    ]);
    const result = mergeAttributions(resourcesByType({ status: "exception" }), dbRows);
    const resource = result.resourcesByType["storage.googleapis.com/Bucket"][0];
    expect(resource.attribution).toMatchObject({ status: "mapped", source: "auto_mapped" });
    expect(result.summary).toMatchObject({ mapped: 1, exception: 0 });
  });

  it("falls back to core's own classification when there's no db row at all", () => {
    const result = mergeAttributions(resourcesByType({ status: "exception" }), new Map());
    const resource = result.resourcesByType["storage.googleapis.com/Bucket"][0];
    expect(resource.attribution).toMatchObject({ status: "exception" });
    expect(result.summary).toMatchObject({ exception: 1, mapped: 0, manual: 0, label: 0 });
  });
});
