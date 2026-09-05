import { describe, it, expect, vi, beforeEach } from "vitest";
import { KubeConfig } from "@kubernetes/client-node";
import {
  createKubeConfig,
  getGcpAccessToken,
  resetPlatformCachesForTests,
  resolveClusterAccessMode,
  usesKubeconfigOnGcp,
  type PlatformDeps,
} from "../../src/kube-client.js";

const TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const PROJECT_URL = "http://metadata.google.internal/computeMetadata/v1/project/project-id";
const CLUSTER_URL =
  "https://container.googleapis.com/v1/projects/sarala-cicd/locations/asia-south1-a/clusters/apex-agent-sandbox";

const INLINE_KUBECONFIG = `apiVersion: v1
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

/** Fake GCP: metadata server + GKE API, keyed by URL. */
function fakePlatform(opts: {
  env?: Record<string, string | undefined>;
  tokens?: Array<{ access_token: string; expires_in: number }>;
  clusterStatus?: number;
} = {}) {
  const tokens = [...(opts.tokens ?? [{ access_token: "tok-1", expires_in: 3599 }])];
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let now = 1_000_000;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (url === TOKEN_URL) {
      if (headers["Metadata-Flavor"] !== "Google") return new Response("", { status: 403 });
      const next = tokens.shift();
      if (!next) throw new Error("fake metadata server: no more tokens scripted");
      return new Response(JSON.stringify(next), { status: 200 });
    }
    if (url === PROJECT_URL) {
      if (headers["Metadata-Flavor"] !== "Google") return new Response("", { status: 403 });
      return new Response("sarala-cicd", { status: 200 });
    }
    if (url === CLUSTER_URL) {
      if (opts.clusterStatus && opts.clusterStatus !== 200) {
        return new Response("", { status: opts.clusterStatus });
      }
      if (!headers.Authorization?.startsWith("Bearer ")) return new Response("", { status: 401 });
      return new Response(
        JSON.stringify({ endpoint: "34.180.12.181", masterAuth: { clusterCaCertificate: "Q0E=" } }),
        { status: 200 },
      );
    }
    return new Response("", { status: 404 });
  });
  const deps: PlatformDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    env: opts.env ?? {},
    now: () => now,
  };
  return { deps, calls, advance: (ms: number) => { now += ms; } };
}

beforeEach(() => resetPlatformCachesForTests());

describe("resolveClusterAccessMode", () => {
  it("prefers gke, then gkeCluster, then inCluster, then kubeconfig", () => {
    const all = {
      gke: { cluster: "c", location: "l" },
      gkeCluster: { endpoint: "e", caData: "c" },
      inCluster: true,
      kubeconfig: INLINE_KUBECONFIG,
    };
    expect(resolveClusterAccessMode(all, {})).toBe("gke");
    expect(resolveClusterAccessMode({ ...all, gke: undefined }, {})).toBe("gke-static");
    expect(resolveClusterAccessMode({ inCluster: true, kubeconfig: INLINE_KUBECONFIG }, {})).toBe("in-cluster");
    expect(resolveClusterAccessMode({ kubeconfig: INLINE_KUBECONFIG }, {})).toBe("kubeconfig");
    expect(resolveClusterAccessMode({}, {})).toBeNull();
  });

  it("on Cloud Run with the cluster named in the deploy env, platform identity beats a pasted kubeconfig", () => {
    const env = { K_SERVICE: "apex-cockpit", PAPERCLIP_GKE_CLUSTER: "c", PAPERCLIP_GKE_LOCATION: "l" };
    expect(resolveClusterAccessMode({ kubeconfig: INLINE_KUBECONFIG }, env)).toBe("gke");
    expect(resolveClusterAccessMode({}, env)).toBe("gke");
    expect(usesKubeconfigOnGcp({ kubeconfig: INLINE_KUBECONFIG }, env)).toBe(false);
  });

  it("flags a kubeconfig-only config on GCP when the deploy does not name the cluster", () => {
    const env = { K_SERVICE: "apex-cockpit" };
    expect(resolveClusterAccessMode({ kubeconfig: INLINE_KUBECONFIG }, env)).toBe("kubeconfig");
    expect(usesKubeconfigOnGcp({ kubeconfig: INLINE_KUBECONFIG }, env)).toBe(true);
    expect(usesKubeconfigOnGcp({ kubeconfig: INLINE_KUBECONFIG }, {})).toBe(false);
  });
});

describe("createKubeConfig", () => {
  it("loads from inline kubeconfig string", async () => {
    const kc = await createKubeConfig({ inCluster: false, kubeconfig: INLINE_KUBECONFIG });
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
    await expect(createKubeConfig({ inCluster: false }, fakePlatform().deps)).rejects.toThrow(/requires/i);
  });

  it("gke mode: reads endpoint + CA from the GKE API and authenticates with a metadata-server token", async () => {
    const { deps, calls } = fakePlatform();
    const kc = await createKubeConfig(
      { gke: { project: "sarala-cicd", location: "asia-south1-a", cluster: "apex-agent-sandbox" } },
      deps,
    );
    expect(kc.getCurrentCluster()?.server).toBe("https://34.180.12.181");
    expect(kc.getCurrentCluster()?.caData).toBe("Q0E=");
    expect(kc.getCurrentUser()?.token).toBe("tok-1");
    const clusterCall = calls.find((c) => c.url === CLUSTER_URL)!;
    expect(clusterCall.headers.Authorization).toBe("Bearer tok-1");
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it("gke mode: fills cluster/location from the deploy env and project from the metadata server", async () => {
    const { deps, calls } = fakePlatform({
      env: { K_SERVICE: "apex-cockpit", PAPERCLIP_GKE_CLUSTER: "apex-agent-sandbox", PAPERCLIP_GKE_LOCATION: "asia-south1-a" },
    });
    // Empty config: the hosted default needs nothing per environment.
    const kc = await createKubeConfig({}, deps);
    expect(kc.getCurrentCluster()?.server).toBe("https://34.180.12.181");
    expect(calls.some((c) => c.url === PROJECT_URL)).toBe(true);
    expect(calls.some((c) => c.url === CLUSTER_URL)).toBe(true);
  });

  it("gke mode: env-named cluster wins over a pasted kubeconfig on Cloud Run", async () => {
    const { deps } = fakePlatform({
      env: { K_SERVICE: "apex-cockpit", PAPERCLIP_GKE_CLUSTER: "apex-agent-sandbox", PAPERCLIP_GKE_LOCATION: "asia-south1-a", PAPERCLIP_GKE_PROJECT: "sarala-cicd" },
    });
    const kc = await createKubeConfig({ kubeconfig: INLINE_KUBECONFIG }, deps);
    expect(kc.getCurrentCluster()?.server).toBe("https://34.180.12.181");
    expect(kc.getCurrentUser()?.token).toBe("tok-1");
  });

  it("gke mode: fails clearly when the cluster is not identified", async () => {
    await expect(createKubeConfig({ gke: {} }, fakePlatform().deps)).rejects.toThrow(/gke\.cluster \+ gke\.location/);
  });

  it("gke mode: surfaces a missing clusterViewer grant", async () => {
    const { deps } = fakePlatform({ clusterStatus: 403 });
    await expect(
      createKubeConfig({ gke: { project: "sarala-cicd", location: "asia-south1-a", cluster: "apex-agent-sandbox" } }, deps),
    ).rejects.toThrow(/clusterViewer/);
  });

  it("gke mode: caches cluster facts and reuses the token across operations", async () => {
    const { deps, calls } = fakePlatform();
    const ref = { gke: { project: "sarala-cicd", location: "asia-south1-a", cluster: "apex-agent-sandbox" } };
    await createKubeConfig(ref, deps);
    await createKubeConfig(ref, deps);
    await createKubeConfig(ref, deps);
    expect(calls.filter((c) => c.url === CLUSTER_URL)).toHaveLength(1);
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it("gkeCluster (static) mode: uses the pinned endpoint + CA with a metadata-server token", async () => {
    const { deps, calls } = fakePlatform();
    const kc = await createKubeConfig({ gkeCluster: { endpoint: "10.0.0.1", caData: "Zm9v" } }, deps);
    expect(kc.getCurrentCluster()?.server).toBe("https://10.0.0.1");
    expect(kc.getCurrentUser()?.token).toBe("tok-1");
    expect(calls.some((c) => c.url === CLUSTER_URL)).toBe(false);
  });

  it("surfaces a clear error when the metadata server is unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    await expect(createKubeConfig({ gkeCluster: { endpoint: "10.0.0.1", caData: "Zm9v" } })).rejects.toThrow(/metadata token request failed/i);
    fetchSpy.mockRestore();
  });
});

describe("getGcpAccessToken refresh", () => {
  it("refreshes before expiry and keeps the cached token otherwise", async () => {
    const { deps, calls, advance } = fakePlatform({
      tokens: [
        { access_token: "tok-1", expires_in: 3600 },
        { access_token: "tok-2", expires_in: 3600 },
      ],
    });
    expect(await getGcpAccessToken(deps)).toBe("tok-1");
    advance(50 * 60 * 1000); // 10 min left: still comfortably valid
    expect(await getGcpAccessToken(deps)).toBe("tok-1");
    advance(6 * 60 * 1000); // 4 min left: inside the refresh margin
    expect(await getGcpAccessToken(deps)).toBe("tok-2");
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it("does not cache a token the metadata server gave no lifetime for", async () => {
    const { deps, calls } = fakePlatform({
      tokens: [
        { access_token: "tok-1", expires_in: 0 },
        { access_token: "tok-2", expires_in: 0 },
      ],
    });
    expect(await getGcpAccessToken(deps)).toBe("tok-1");
    expect(await getGcpAccessToken(deps)).toBe("tok-2");
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });
});
