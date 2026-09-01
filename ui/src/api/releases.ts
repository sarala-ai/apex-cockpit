import type { ConfoundSet, Release, ReleaseDetail, ReleaseNotes } from "@paperclipai/shared";
import { api } from "./client";

export const releasesApi = {
  list: (companyId: string) => api.get<Release[]>(`/companies/${companyId}/releases`),
  detail: (id: string) => api.get<ReleaseDetail>(`/releases/${id}`),
  notes: (id: string) => api.get<ReleaseNotes>(`/releases/${id}/notes`),
  /**
   * "What else shipped in this product's release window?" — the question the
   * release object exists to answer.
   */
  confounds: (
    companyId: string,
    params: { windowStart: string; windowEnd: string; initiativeId?: string },
  ) => {
    const search = new URLSearchParams({
      windowStart: params.windowStart,
      windowEnd: params.windowEnd,
    });
    if (params.initiativeId) search.set("initiativeId", params.initiativeId);
    return api.get<ConfoundSet>(`/companies/${companyId}/releases/confounds?${search.toString()}`);
  },
};
