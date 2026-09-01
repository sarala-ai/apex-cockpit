import {
  KubeConfig,
  CoreV1Api,
  BatchV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
} from "@kubernetes/client-node";

export interface CreateKubeConfigInput {
  inCluster?: boolean;
  kubeconfig?: string;
  gkeCluster?: { endpoint: string; caData: string };
}

/** GCE/Cloud Run metadata server — only resolvable ON Google infrastructure,
 *  and only ever returns tokens for the workload's own attached service
 *  account, so there is no credential to configure or store. */
const GCP_METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

async function fetchGcpAccessToken(): Promise<string> {
  const res = await fetch(GCP_METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`GCP metadata token request failed (HTTP ${res.status}) — gkeCluster mode requires running on GCP (Cloud Run/GCE) with an attached service account`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("GCP metadata server returned no access_token");
  return body.access_token;
}

export async function createKubeConfig(input: CreateKubeConfigInput): Promise<KubeConfig> {
  const kc = new KubeConfig();
  if (input.inCluster) {
    kc.loadFromCluster();
    return kc;
  }
  if (input.gkeCluster) {
    // Token is fetched fresh per KubeConfig (i.e. per provider operation), so
    // expiry (~1h) never matters: no operation holds a config that long.
    const token = await fetchGcpAccessToken();
    const server = input.gkeCluster.endpoint.startsWith("https://")
      ? input.gkeCluster.endpoint
      : `https://${input.gkeCluster.endpoint}`;
    kc.loadFromOptions({
      clusters: [{ name: "gke", server, caData: input.gkeCluster.caData }],
      users: [{ name: "gcp-sa", token }],
      contexts: [{ name: "gke", cluster: "gke", user: "gcp-sa" }],
      currentContext: "gke",
    });
    return kc;
  }
  if (input.kubeconfig && input.kubeconfig.trim().length > 0) {
    kc.loadFromString(input.kubeconfig);
    return kc;
  }
  throw new Error("createKubeConfig requires one of inCluster=true, gkeCluster, or a kubeconfig string");
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
