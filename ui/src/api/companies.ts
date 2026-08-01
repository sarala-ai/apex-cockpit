import type {
  Company,
  CompanyIdentityPreview,
  CompanyPortabilityExportRequest,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImportRequest,
  CompanyPortabilityImportResult,
  CompanyPortabilityPreviewRequest,
  CompanyPortabilityPreviewResult,
  CompanySlugBreakGlassConsequences,
  UpdateCompanyBranding,
} from "@paperclipai/shared";
import { api } from "./client";

export interface CompanySlugBreakGlassResult {
  preview: boolean;
  consequences: CompanySlugBreakGlassConsequences;
  company?: Company;
  activityId?: string | null;
}

export type CompanyStats = Record<string, { agentCount: number; issueCount: number }>;

export const companiesApi = {
  list: () => api.get<Company[]>("/companies"),
  get: (companyId: string) => api.get<Company>(`/companies/${companyId}`),
  stats: () => api.get<CompanyStats>("/companies/stats"),
  // Read-only preview of the issue prefix + slug create() would allocate for
  // `name`, plus availability against existing companies — used by the
  // onboarding wizard's identity step so a taken value is caught before
  // submit, not as a 500 afterward. See companyService.identityPreview.
  identityPreview: (
    name: string,
    overrides?: { issuePrefix?: string; slug?: string },
    options?: { signal?: AbortSignal },
  ) => {
    const params = new URLSearchParams({ name });
    if (overrides?.issuePrefix) params.set("prefix", overrides.issuePrefix);
    if (overrides?.slug) params.set("slug", overrides.slug);
    return api.get<CompanyIdentityPreview>(`/companies/identity-preview?${params.toString()}`, options);
  },
  create: (data: {
    name: string;
    description?: string | null;
    budgetMonthlyCents?: number;
    // One-time, at creation — see companyIssuePrefixSchema. Omit to
    // auto-derive from the company name. An explicit value wins over
    // derivation and is NOT retried with a suffix on collision.
    issuePrefix?: string;
    // One-time, at creation — see companySlugSchema. Omit to auto-derive.
    slug?: string;
  }) =>
    api.post<Company>("/companies", data),
  update: (
    companyId: string,
    data: Partial<
      Pick<
        Company,
        | "name"
        | "description"
        | "status"
        | "budgetMonthlyCents"
        | "attachmentMaxBytes"
        | "requireBoardApprovalForNewAgents"
        | "feedbackDataSharingEnabled"
        | "brandColor"
        | "logoAssetId"
        // Write-once: only accepted by the server when the company's current
        // slug is null. See companyService.update.
        | "slug"
      >
    >,
  ) => api.patch<Company>(`/companies/${companyId}`, data),
  updateBranding: (companyId: string, data: UpdateCompanyBranding) =>
    api.patch<Company>(`/companies/${companyId}/branding`, data),
  // Break-glass slug change — the one deliberate escape hatch out of write-once
  // immutability. Omit `confirm` to fetch the consequences preview (no write);
  // pass `confirm` set to the CURRENT slug to execute. NEVER reachable through
  // `update()` — see companyService.breakGlassChangeSlug.
  slugBreakGlassPreview: (companyId: string, newSlug: string) =>
    api.post<CompanySlugBreakGlassResult>(`/companies/${companyId}/slug-break-glass`, { newSlug }),
  slugBreakGlassExecute: (companyId: string, newSlug: string, confirm: string) =>
    api.post<CompanySlugBreakGlassResult>(`/companies/${companyId}/slug-break-glass`, { newSlug, confirm }),
  archive: (companyId: string) => api.post<Company>(`/companies/${companyId}/archive`, {}),
  remove: (companyId: string) => api.delete<{ ok: true }>(`/companies/${companyId}`),
  exportBundle: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportResult>(`/companies/${companyId}/exports`, data),
  exportPreview: (
    companyId: string,
    data: CompanyPortabilityExportRequest,
  ) =>
    api.post<CompanyPortabilityExportPreviewResult>(`/companies/${companyId}/exports/preview`, data),
  importPreview: (data: CompanyPortabilityPreviewRequest) =>
    api.post<CompanyPortabilityPreviewResult>("/companies/import/preview", data),
  importBundle: (data: CompanyPortabilityImportRequest) =>
    api.post<CompanyPortabilityImportResult>("/companies/import", data),
};
