import { describe, expect, it } from "vitest";
import { resolveRuntimeBind, validateConfiguredBindMode } from "@paperclipai/shared";
import { buildPresetServerConfig } from "../config/server-bind.js";

const ORIGINAL_PATH = process.env.PATH;

describe("network bind helpers", () => {
  it("rejects non-loopback bind modes in local_trusted", () => {
    /*
     * Substring, not equality. Array `toContain` demands an exact element
     * match, so this assertion broke the moment the message grew its
     * APEX_LOCAL_CONTAINER clause — reporting a failed security control when
     * the control was working correctly. The rule under test is that binding
     * a trusted-no-login deployment off loopback is refused; the exact
     * remediation wording is free to change.
     */
    expect(
      validateConfiguredBindMode({
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        bind: "lan",
        host: "0.0.0.0",
      }),
    ).toEqual([expect.stringContaining("local_trusted requires server.bind=loopback")]);
  });

  /*
   * The container escape hatch (identity spec rule 3). It waives the loopback
   * requirement on an operator's word that the published port is bound to the
   * host's 127.0.0.1, and until now nothing tested it at all — which is how
   * the assertion above came to be broken by the very change that added it.
   * An unwitnessed waiver of a network boundary is the one thing here that
   * must not go unwitnessed.
   */
  it("waives the loopback requirement only when the operator acknowledges a local container", () => {
    const binding = {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bind: "lan",
      host: "0.0.0.0",
    } as const;

    expect(validateConfiguredBindMode({ ...binding, localContainerAck: true })).toEqual([]);
    expect(validateConfiguredBindMode({ ...binding, localContainerAck: false })).toEqual([
      expect.stringContaining("local_trusted requires server.bind=loopback"),
    ]);
  });

  it("does not let the container acknowledgement waive any other bind rule", () => {
    // The ack speaks to one thing only: a published container port. It must not
    // become a blanket suppressor for unrelated misconfiguration.
    expect(
      validateConfiguredBindMode({
        deploymentMode: "authenticated",
        deploymentExposure: "public",
        bind: "tailnet",
        host: "100.64.0.8",
        localContainerAck: true,
      }),
    ).toEqual([
      expect.stringContaining("server.bind=tailnet is only supported for authenticated/private"),
    ]);
  });

  it("resolves tailnet bind using the detected tailscale address", () => {
    const resolved = resolveRuntimeBind({
      bind: "tailnet",
      host: "127.0.0.1",
      tailnetBindHost: "100.64.0.8",
    });

    expect(resolved.errors).toEqual([]);
    expect(resolved.host).toBe("100.64.0.8");
  });

  it("requires a custom bind host when bind=custom", () => {
    const resolved = resolveRuntimeBind({
      bind: "custom",
      host: "127.0.0.1",
    });

    expect(resolved.errors).toContain("server.customBindHost is required when server.bind=custom");
  });

  it("stores the detected tailscale address for tailnet presets", () => {
    process.env.PAPERCLIP_TAILNET_BIND_HOST = "100.64.0.8";

    const preset = buildPresetServerConfig("tailnet", {
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    });

    expect(preset.server.host).toBe("100.64.0.8");

    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
  });

  it("falls back to loopback when no tailscale address is available for tailnet presets", () => {
    delete process.env.PAPERCLIP_TAILNET_BIND_HOST;
    process.env.PATH = "";

    try {
      const preset = buildPresetServerConfig("tailnet", {
        port: 3100,
        allowedHostnames: [],
        serveUi: true,
      });

      expect(preset.server.host).toBe("127.0.0.1");
    } finally {
      process.env.PATH = ORIGINAL_PATH;
    }
  });
});
