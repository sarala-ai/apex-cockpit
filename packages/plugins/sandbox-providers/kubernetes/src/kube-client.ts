import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
} from "@kubernetes/client-node";

/** Identifies a GKE cluster; endpoint + CA are then read from the GKE API. */
export interface GkeClusterRef {
  project?: string;
  location?: string;
  cluster?: string;
}

export interface CreateKubeConfigInput {
  inCluster?: boolean;
  kubeconfig?: string;
  gkeCluster?: { endpoint: string; caData: string };
  gke?: GkeClusterRef;
}

/** Injection seam for tests; production uses the real fetch/env/clock. */
export interface PlatformDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  now: () => number;
}

function defaultDeps(): PlatformDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    env: process.env,
    now: () => Date.now(),
  };
}

/** GCE/Cloud Run metadata server — only resolvable ON Google infrastructure,
 *  and only ever returns tokens for the workload's own attached service
 *  account, so there is no credential to configure or store. */
const GCP_METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";
const GCP_METADATA_TOKEN_URL = `${GCP_METADATA_BASE}/instance/service-accounts/default/token`;
const GCP_METADATA_PROJECT_URL = `${GCP_METADATA_BASE}/project/project-id`;
const GKE_API_BASE = "https://container.googleapis.com/v1";

/** Refresh the cached access token this long before the metadata server says
 *  it expires, so a token handed to a long exec/watch never dies mid-call. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
const clusterFactsCache = new Map<string, { endpoint: string; caData: string }>();

/** Clears the token + cluster-facts caches. Tests only. */
export function resetPlatformCachesForTests(): void {
  cachedToken = null;
  clusterFactsCache.clear();
}

async function metadataGet(deps: PlatformDeps, url: string): Promise<Response> {
  return deps.fetch(url, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5000),
  });
}

export async function getGcpAccessToken(deps: PlatformDeps = defaultDeps()): Promise<string> {
  const now = deps.now();
  if (cachedToken && cachedToken.expiresAt - now > TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.token;
  }
  const res = await metadataGet(deps, GCP_METADATA_TOKEN_URL);
  if (!res.ok) {
    throw new Error(
      `GCP metadata token request failed (HTTP ${res.status}) — GKE platform-identity mode requires running on GCP (Cloud Run/GCE) with an attached service account`,
    );
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("GCP metadata server returned no access_token");
  const ttlMs = (typeof body.expires_in === "number" ? body.expires_in : 0) * 1000;
  cachedToken = { token: body.access_token, expiresAt: now + ttlMs };
  return body.access_token;
}

async function getGcpProjectId(deps: PlatformDeps): Promise<string> {
  const res = await metadataGet(deps, GCP_METADATA_PROJECT_URL);
  if (!res.ok) {
    throw new Error(`GCP metadata project-id request failed (HTTP ${res.status})`);
  }
  const id = (await res.text()).trim();
  if (!id) throw new Error("GCP metadata server returned an empty project id");
  return id;
}

/** Fills a partial cluster ref from the deploy environment, then the metadata
 *  server (project only), so a hosted cockpit needs no per-environment config. */
async function resolveGkeClusterRef(ref: GkeClusterRef, deps: PlatformDeps): Promise<Required<GkeClusterRef>> {
  const cluster = ref.cluster ?? deps.env.PAPERCLIP_GKE_CLUSTER;
  const location = ref.location ?? deps.env.PAPERCLIP_GKE_LOCATION;
  let project = ref.project ?? deps.env.PAPERCLIP_GKE_PROJECT;
  if (!cluster || !location) {
    throw new Error(
      "gke mode needs the cluster name and location — set gke.cluster + gke.location in the environment config, or PAPERCLIP_GKE_CLUSTER + PAPERCLIP_GKE_LOCATION on the server",
    );
  }
  if (!project) project = await getGcpProjectId(deps);
  return { project, location, cluster };
}

/** Public cluster facts (control-plane endpoint + CA) via the GKE API. Needs
 *  only roles/container.clusterViewer on the caller. Cached: they don't change
 *  for the life of a cluster. */
export async function getGkeClusterFacts(
  ref: GkeClusterRef,
  deps: PlatformDeps = defaultDeps(),
): Promise<{ endpoint: string; caData: string }> {
  const { project, location, cluster } = await resolveGkeClusterRef(ref, deps);
  const key = `${project}/${location}/${cluster}`;
  const cached = clusterFactsCache.get(key);
  if (cached) return cached;

  const token = await getGcpAccessToken(deps);
  const url = `${GKE_API_BASE}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/clusters/${encodeURIComponent(cluster)}`;
  const res = await deps.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(
      `GKE cluster lookup failed (HTTP ${res.status}) for ${key} — the server's service account needs roles/container.clusterViewer on the project`,
    );
  }
  const body = (await res.json()) as {
    endpoint?: string;
    masterAuth?: { clusterCaCertificate?: string };
  };
  if (!body.endpoint || !body.masterAuth?.clusterCaCertificate) {
    throw new Error(`GKE cluster ${key} returned no endpoint/CA`);
  }
  const facts = { endpoint: body.endpoint, caData: body.masterAuth.clusterCaCertificate };
  clusterFactsCache.set(key, facts);
  return facts;
}

export type ClusterAccessMode = "gke" | "gke-static" | "in-cluster" | "kubeconfig";

/**
 * Which access path a config resolves to. Platform identity wins wherever it
 * is available: an explicit `gke`/`gkeCluster` block, or — on Cloud Run
 * (`K_SERVICE`) with the cluster named in the deploy env — even when a
 * kubeconfig is also present. A pasted kubeconfig is the local/dev path only.
 */
export function resolveClusterAccessMode(
  input: CreateKubeConfigInput,
  env: Record<string, string | undefined> = process.env,
): ClusterAccessMode | null {
  if (input.gke) return "gke";
  if (input.gkeCluster) return "gke-static";
  if (input.inCluster) return "in-cluster";
  if (env.K_SERVICE && env.PAPERCLIP_GKE_CLUSTER && env.PAPERCLIP_GKE_LOCATION) return "gke";
  if (input.kubeconfig && input.kubeconfig.trim().length > 0) return "kubeconfig";
  return null;
}

/** True when the process is hosted on GCP but this config would still use a
 *  pasted kubeconfig — a stored credential where the platform identity should be. */
export function usesKubeconfigOnGcp(
  input: CreateKubeConfigInput,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.K_SERVICE) && resolveClusterAccessMode(input, env) === "kubeconfig";
}

function loadGkeTokenConfig(kc: KubeConfig, endpoint: string, caData: string, token: string): void {
  const server = endpoint.startsWith("https://") ? endpoint : `https://${endpoint}`;
  kc.loadFromOptions({
    clusters: [{ name: "gke", server, caData }],
    users: [{ name: "gcp-sa", token }],
    contexts: [{ name: "gke", cluster: "gke", user: "gcp-sa" }],
    currentContext: "gke",
  });
}

export async function createKubeConfig(
  input: CreateKubeConfigInput,
  deps: PlatformDeps = defaultDeps(),
): Promise<KubeConfig> {
  const kc = new KubeConfig();
  const mode = resolveClusterAccessMode(input, deps.env);
  switch (mode) {
    case "in-cluster":
      kc.loadFromCluster();
      return kc;
    case "gke": {
      // A KubeConfig is built per provider operation; the token behind it is
      // cached and refreshed ahead of expiry (see getGcpAccessToken).
      const facts = await getGkeClusterFacts(input.gke ?? {}, deps);
      loadGkeTokenConfig(kc, facts.endpoint, facts.caData, await getGcpAccessToken(deps));
      return kc;
    }
    case "gke-static": {
      const { endpoint, caData } = input.gkeCluster!;
      loadGkeTokenConfig(kc, endpoint, caData, await getGcpAccessToken(deps));
      return kc;
    }
    case "kubeconfig":
      kc.loadFromString(input.kubeconfig!);
      return kc;
    default:
      throw new Error(
        "createKubeConfig requires one of gke, gkeCluster, inCluster=true, or a kubeconfig string",
      );
  }
}

export interface KubeClients {
  core: CoreV1Api;
  batch: BatchV1Api;
  custom: CustomObjectsApi;
  networking: NetworkingV1Api;
  rbac: RbacAuthorizationV1Api;
}

export function makeKubeClients(kc: KubeConfig): KubeClients {
  return {
    core: kc.makeApiClient(CoreV1Api),
    batch: kc.makeApiClient(BatchV1Api),
    custom: kc.makeApiClient(CustomObjectsApi),
    networking: kc.makeApiClient(NetworkingV1Api),
    rbac: kc.makeApiClient(RbacAuthorizationV1Api),
  };
}
