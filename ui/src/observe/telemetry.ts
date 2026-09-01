// Browser OpenTelemetry — client-side half of the correlation spine.
//
// GATED on `VITE_APEX_OTLP_ENDPOINT`. When unset, `initTelemetry()` is a no-op:
// no SDK is constructed, no spans are created, no network calls are made, and
// `fetch` is never patched. Zero behavior change for every deployment that
// doesn't opt in.
//
// When enabled, this:
//   - Assigns a per-browser-session id (`session.id`, the spine's USER PLANE
//     key — see server/src/observe/contract.ts) persisted in sessionStorage,
//     as a resource attribute alongside `service.name` and `apex.env`.
//   - Registers FetchInstrumentation so outgoing `fetch()` calls to the
//     cockpit API get a client span AND a W3C `traceparent` header, so the
//     server (when it also has OTEL_EXPORTER_OTLP_ENDPOINT set — see
//     server/src/instrumentation.ts) continues the SAME trace.
//   - Exports via OTLP/HTTP to VITE_APEX_OTLP_ENDPOINT.
//
// STRUCTURE ONLY: fetch instrumentation captures URL, method, status, and
// timing — never request/response bodies. This is an internal tool (implicit
// consent), but we still don't want request/response payloads (which may
// carry PII) flowing into spans.
//
// This module intentionally does NOT eagerly import the OTel packages at the
// top level of any *other* module that's always loaded — `initTelemetry` is
// called once from main.tsx, and internally everything after the env check
// is plain synchronous imports (these packages are real dependencies here,
// unlike the server's optional-dynamic-import approach, because the UI
// bundles once and ships a single artifact either way).

import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { WebTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-web";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { ZoneContextManager } from "@opentelemetry/context-zone";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import type { Span } from "@opentelemetry/api";

// Mirrors server/src/observe/contract.ts::Spine. Duplicated (not imported)
// because the contract module lives in the server package and pulls in
// server-only deps transitively; the UI only needs these three string keys.
const SPINE_SESSION_ID = "session.id";
const SPINE_COMPANY_ID = "apex.company.id";
const SPINE_ENV = "apex.env";

const SESSION_STORAGE_KEY = "paperclip.otel.sessionId";

function getOrCreateSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const next = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  } catch {
    // sessionStorage unavailable (privacy mode, etc.) — fall back to an
    // in-memory id for the lifetime of this page load.
    return crypto.randomUUID();
  }
}

/** Test-only: current active company id getter, set by `initTelemetry`. */
let getCompanyId: (() => string | null) | null = null;

/**
 * Registers a callback the fetch instrumentation uses to stamp the current
 * company onto each client span. Call after `initTelemetry` from a component
 * with access to company selection (e.g. CompanyProvider); safe to call
 * before init too — telemetry is a no-op until `initTelemetry` runs.
 */
export function setActiveCompanyIdProvider(provider: () => string | null): void {
  getCompanyId = provider;
}

let initialized = false;

/**
 * Initializes browser OTel tracing. No-op (and safe to call multiple times)
 * when `VITE_APEX_OTLP_ENDPOINT` is unset or this has already run.
 *
 * `propagateTraceHeaderCorsUrls` is restricted to `backendOrigin` so
 * `traceparent` is only ever sent to our own API, never to third-party
 * origins the app might fetch from.
 */
export function initTelemetry(): void {
  if (initialized) return;
  const endpoint = import.meta.env.VITE_APEX_OTLP_ENDPOINT?.trim();
  if (!endpoint) return;
  initialized = true;

  const env = import.meta.env.VITE_APEX_ENV?.trim() || "local";
  const backendOrigin = window.location.origin;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "apex-cockpit-ui",
    [SPINE_SESSION_ID]: getOrCreateSessionId(),
    [SPINE_ENV]: env,
  });

  const provider = new WebTracerProvider({
    resource,
    spanProcessors: [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint })),
    ],
  });

  provider.register({
    contextManager: new ZoneContextManager(),
    propagator: new W3CTraceContextPropagator(),
  });

  registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new FetchInstrumentation({
        // Only inject `traceparent` on calls to our own backend — never to
        // third-party origins (CORS would reject an unexpected header
        // anyway, but this keeps intent explicit).
        propagateTraceHeaderCorsUrls: [backendOrigin],
        // Structure only: no body capture. `applyCustomAttributesOnSpan`
        // only ever reads url/method/status (already collected by the
        // instrumentation itself) — this hook exists to stamp the spine's
        // company id, not to enrich with payload data.
        applyCustomAttributesOnSpan: (span: Span) => {
          const companyId = getCompanyId?.();
          if (companyId) span.setAttribute(SPINE_COMPANY_ID, companyId);
        },
      }),
    ],
  });
}
