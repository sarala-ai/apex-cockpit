import type { Proposal, ProposalColumn, ProposalRecord } from "@paperclipai/shared";
import { api } from "./client";

export type ProposalKindDescriptor = {
  kind: string;
  label: string;
  columns: ProposalColumn[];
};

export type CorrectRecordResult = {
  proposal: Proposal;
  record: ProposalRecord;
  /** Advisory: a half-corrected row stays saveable, the gate stops it. */
  fieldsError: string | null;
};

export const proposalsApi = {
  kinds: () => api.get<ProposalKindDescriptor[]>("/proposal-kinds"),
  list: (companyId: string) => api.get<Proposal[]>(`/companies/${companyId}/proposals`),
  get: (id: string) => api.get<Proposal>(`/proposals/${id}`),
  create: (companyId: string, data: Record<string, unknown>) =>
    api.post<Proposal>(`/companies/${companyId}/proposals`, data),
  correctRecord: (id: string, ref: string, patch: Record<string, unknown>) =>
    api.patch<CorrectRecordResult>(
      `/proposals/${id}/records/${encodeURIComponent(ref)}`,
      patch,
    ),
  submit: (id: string, note?: string | null) =>
    api.post<{ proposal: Proposal; approvalId: string | null }>(`/proposals/${id}/submit`, {
      note: note ?? null,
    }),
  /** Offline scanning, not the review path — see ProposalReview. */
  exportCsvUrl: (id: string) => `/api/proposals/${id}/export.csv`,
};
