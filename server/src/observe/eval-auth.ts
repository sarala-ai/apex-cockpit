// apex-eval is a private Cloud Run service: calls from a hosted cockpit carry
// a Google ID token for the eval URL's audience, minted by the runtime's
// metadata server. Off GCP (local dev, tests) callers talk plain HTTP.
const METADATA_IDENTITY_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

export async function evalAuthorization(evalUrl: string): Promise<Record<string, string>> {
  if (!process.env.K_SERVICE || !evalUrl.startsWith("https://")) return {};
  try {
    const res = await fetch(`${METADATA_IDENTITY_URL}?audience=${encodeURIComponent(new URL(evalUrl).origin)}`, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return {};
    return { authorization: `Bearer ${await res.text()}` };
  } catch {
    return {};
  }
}
