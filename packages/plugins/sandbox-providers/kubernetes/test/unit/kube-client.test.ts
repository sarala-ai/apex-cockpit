import { describe, it, expect, vi } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";
import { createKubeConfig } from "../../src/kube-client.js";

describe("createKubeConfig", () => {
  it("loads from inline kubeconfig string", async () => {
    const yaml = `apiVersion: v1
kind: Config
clusters:
  - name: test
    cluster:
      server: https://fake.example.com
contexts:
  - name: test
    context:
      cluster: test
      user: test
current-context: test
users:
  - name: test
    user:
      token: fake-token
`;
    const kc = await createKubeConfig({ inCluster: false, kubeconfig: yaml });
    expect(kc.getCurrentContext()).toBe("test");
    expect(kc.getCurrentCluster()?.server).toBe("https://fake.example.com");
  });

  it("loads from-cluster config when inCluster=true", async () => {
    const spy = vi.spyOn(KubeConfig.prototype, "loadFromCluster").mockImplementation(function (this: KubeConfig) {
      this.loadFromString(`apiVersion: v1
kind: Config
clusters: [{name: in-cluster, cluster: {server: 'https://kubernetes.default.svc'}}]
contexts: [{name: in-cluster, context: {cluster: in-cluster, user: in-cluster}}]
current-context: in-cluster
users: [{name: in-cluster, user: {token: tok}}]`);
    });
    const kc = await createKubeConfig({ inCluster: true });
    expect(spy).toHaveBeenCalledOnce();
    expect(kc.getCurrentContext()).toBe("in-cluster");
    spy.mockRestore();
  });

  it("rejects when no auth source is provided", async () => {
    await expect(createKubeConfig({ inCluster: false })).rejects.toThrow(/requires/i);
  });

  it("builds a token config for gkeCluster from the metadata server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "gcp-tok", expires_in: 3599 }), { status: 200 }),
    );
    const kc = await createKubeConfig({ gkeCluster: { endpoint: "10.0.0.1", caData: "Zm9v" } });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(kc.getCurrentCluster()?.server).toBe("https://10.0.0.1");
    expect(kc.getCurrentUser()?.token).toBe("gcp-tok");
    fetchSpy.mockRestore();
  });

  it("surfaces a clear error when the metadata server is unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    await expect(createKubeConfig({ gkeCluster: { endpoint: "10.0.0.1", caData: "Zm9v" } })).rejects.toThrow(/metadata token request failed/i);
    fetchSpy.mockRestore();
  });
});
