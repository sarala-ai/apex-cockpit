// Capability sync status/refresh (cockpit Workflows page banner). Talks to
// the Express `/api/apex/capabilities/sync` route
// (server/src/routes/apex-capabilities.ts) — GET reads the last summary the
// periodic job holds in memory (cheap, no CLI shell), POST triggers an
// on-demand refresh. Both always 200; a degraded/unreleased CLI comes back
// as a classified `CapabilitySyncError` inside `summary`, never an HTTP
// error — callers branch on `summary?.status` rather than `isError`.

import { api } from "./client";
import type { CapabilitySyncStatusResponse } from "@paperclipai/shared";

export const capabilitySyncApi = {
  status: () => api.get<CapabilitySyncStatusResponse>("/apex/capabilities/sync"),
  sync: () => api.post<CapabilitySyncStatusResponse>("/apex/capabilities/sync", {}),
};
