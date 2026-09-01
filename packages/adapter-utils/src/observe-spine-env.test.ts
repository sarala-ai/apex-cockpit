import { describe, expect, it } from "vitest";
import {
  buildResourceAttributes,
  mergeResourceAttributes,
  otelEnv,
  type RunSpine,
} from "./observe-spine-env.js";

describe("buildResourceAttributes", () => {
  it("emits only present spine keys using the exact contract keys, in order", () => {
    const spine: RunSpine = {
      companyId: "co-1",
      agentId: "ag-1",
      agentKind: "claude_local",
      runId: "run-1",
      repo: "sarala/apex",
      env: "dev",
      // absent: orgId, projectId, agentName, issueId, workflow*, resourceId
    };
    expect(buildResourceAttributes(spine)).toBe(
      "apex.company.id=co-1,apex.agent.id=ag-1,apex.agent.kind=claude_local,apex.run.id=run-1,apex.repo=sarala/apex,apex.env=dev",
    );
  });

  it("skips empty/whitespace and values containing , or =", () => {
    const spine: RunSpine = {
      companyId: "co-1",
      agentName: "   ",
      issueId: "has,comma",
      repo: "has=equals",
      runId: "run-1",
    };
    expect(buildResourceAttributes(spine)).toBe("apex.company.id=co-1,apex.run.id=run-1");
  });

  it("returns empty string when no spine values are present", () => {
    expect(buildResourceAttributes({})).toBe("");
  });
});

describe("mergeResourceAttributes", () => {
  it("preserves caller-set attributes, appending ours", () => {
    expect(mergeResourceAttributes("service.name=x", "apex.run.id=run-1")).toBe(
      "service.name=x,apex.run.id=run-1",
    );
  });

  it("returns spine attrs alone when nothing pre-existing", () => {
    expect(mergeResourceAttributes(undefined, "apex.run.id=run-1")).toBe("apex.run.id=run-1");
    expect(mergeResourceAttributes("", "apex.run.id=run-1")).toBe("apex.run.id=run-1");
  });

  it("returns existing alone when spine attrs empty", () => {
    expect(mergeResourceAttributes("service.name=x", "")).toBe("service.name=x");
  });
});

describe("otelEnv", () => {
  const spine: RunSpine = { companyId: "co-1", runId: "run-1" };

  it("adds endpoint + resource attributes when an endpoint is configured", () => {
    const out = otelEnv(spine, "http://localhost:4317");
    expect(out).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4317",
      OTEL_RESOURCE_ATTRIBUTES: "apex.company.id=co-1,apex.run.id=run-1",
    });
  });

  it("preserves caller's pre-existing OTEL_RESOURCE_ATTRIBUTES (append, no clobber)", () => {
    const out = otelEnv(spine, "http://localhost:4317", "deployment.environment=local");
    expect(out.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "deployment.environment=local,apex.company.id=co-1,apex.run.id=run-1",
    );
  });

  it("sets only the endpoint when the spine has no emittable values", () => {
    const out = otelEnv({}, "http://localhost:4317");
    expect(out).toEqual({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4317" });
  });

  it("GATED: adds NO OTEL_* vars when no endpoint is configured", () => {
    expect(otelEnv(spine, undefined)).toEqual({});
    expect(otelEnv(spine, "")).toEqual({});
    expect(otelEnv(spine, "   ")).toEqual({});
    expect(otelEnv(spine, null)).toEqual({});
  });
});
