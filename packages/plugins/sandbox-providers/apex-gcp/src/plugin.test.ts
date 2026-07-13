import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";

const base = { driverKey: "apex-gcp", companyId: "co-1", environmentId: "env-abc-123" };

describe("apex-gcp plugin", () => {
  it("is healthy and registers the sandbox-provider handlers", async () => {
    expect(await plugin.definition.onHealth?.()).toEqual({
      status: "ok",
      message: expect.stringContaining("apex-gcp"),
    });
    expect(plugin.definition.onEnvironmentAcquireLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentExecute).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentReleaseLease).toBeTypeOf("function");
    expect(plugin.definition.onEnvironmentDestroyLease).toBeTypeOf("function");
  });

  describe("onEnvironmentValidateConfig", () => {
    it("accepts a valid config and normalizes defaults", async () => {
      const result = await plugin.definition.onEnvironmentValidateConfig?.({
        ...base,
        config: { projectId: "sarala-cicd", zone: "asia-south1-a", apexVersion: "0.4.2" },
      });
      expect(result?.ok).toBe(true);
      expect((result?.normalizedConfig as Record<string, unknown>)?.machineType).toBe("e2-medium");
    });

    it("requires projectId and zone", async () => {
      const result = await plugin.definition.onEnvironmentValidateConfig?.({
        ...base,
        config: {},
      });
      expect(result?.ok).toBe(false);
      expect(result?.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("projectId"),
          expect.stringContaining("zone"),
        ]),
      );
    });

    it("warns when apexVersion is unset (unpinned apex)", async () => {
      const result = await plugin.definition.onEnvironmentValidateConfig?.({
        ...base,
        config: { projectId: "p", zone: "asia-south1-a" },
      });
      expect(result?.ok).toBe(true);
      expect(result?.warnings).toEqual(
        expect.arrayContaining([expect.stringContaining("apexVersion is unset")]),
      );
    });

    it("rejects a too-small disk", async () => {
      const result = await plugin.definition.onEnvironmentValidateConfig?.({
        ...base,
        config: { projectId: "p", zone: "asia-south1-a", diskSizeGb: 5 },
      });
      expect(result?.ok).toBe(false);
      expect(result?.errors).toEqual(expect.arrayContaining([expect.stringContaining("diskSizeGb")]));
    });
  });
});
