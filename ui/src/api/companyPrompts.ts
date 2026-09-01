import type {
  CompanyPromptListItem,
  CompanyPromptDetail,
  CompanyPromptVersion,
  CompanyPromptLabel,
  CompanyPromptCreateRequest,
  CompanyPromptUpdateRequest,
  CompanyPromptVersionCreateRequest,
  CompanyPromptLabelSetRequest,
  CompanyPromptResolveResult,
  GatewayPromptEntry,
} from "@paperclipai/shared";
import { api } from "./client";

export const companyPromptsApi = {
  list: (companyId: string) =>
    api.get<CompanyPromptListItem[]>(`/companies/${encodeURIComponent(companyId)}/prompts`),

  create: (companyId: string, payload: CompanyPromptCreateRequest) =>
    api.post<CompanyPromptDetail>(`/companies/${encodeURIComponent(companyId)}/prompts`, payload),

  detail: (companyId: string, promptId: string) =>
    api.get<CompanyPromptDetail>(`/companies/${encodeURIComponent(companyId)}/prompts/${encodeURIComponent(promptId)}`),

  update: (companyId: string, promptId: string, payload: CompanyPromptUpdateRequest) =>
    api.patch<CompanyPromptDetail>(
      `/companies/${encodeURIComponent(companyId)}/prompts/${encodeURIComponent(promptId)}`,
      payload,
    ),

  delete: (companyId: string, promptId: string) =>
    api.delete(`/companies/${encodeURIComponent(companyId)}/prompts/${encodeURIComponent(promptId)}`),

  versions: (companyId: string, promptId: string) =>
    api.get<CompanyPromptVersion[]>(
      `/companies/${encodeURIComponent(companyId)}/prompts/${encodeURIComponent(promptId)}/versions`,
    ),

  createVersion: (companyId: string, promptId: string, payload: CompanyPromptVersionCreateRequest) =>
    api.post<CompanyPromptVersion>(
      `/companies/${encodeURIComponent(companyId)}/prompts/${encodeURIComponent(promptId)}/versions`,
      payload,
    ),

  labels: (companyId: string, promptId: string) =>
    api.get<CompanyPromptLabel[]>(
      `/companies/${encodeURIComponent(companyId)}/prompts/${encodeURIComponent(promptId)}/labels`,
    ),

  setLabel: (companyId: string, promptId: string, labelName: string, payload: CompanyPromptLabelSetRequest) =>
    api.put<CompanyPromptLabel>(
      `/companies/${encodeURIComponent(companyId)}/prompts/${encodeURIComponent(promptId)}/labels/${encodeURIComponent(labelName)}`,
      payload,
    ),

  deleteLabel: (companyId: string, promptId: string, labelName: string) =>
    api.delete(
      `/companies/${encodeURIComponent(companyId)}/prompts/${encodeURIComponent(promptId)}/labels/${encodeURIComponent(labelName)}`,
    ),

  resolve: (companyId: string, promptId: string, labelName: string) =>
    api.get<CompanyPromptResolveResult>(
      `/companies/${encodeURIComponent(companyId)}/prompts/resolve/${encodeURIComponent(labelName)}?promptId=${encodeURIComponent(promptId)}`,
    ),

  gatewayPrompts: (companyId: string) =>
    api.get<GatewayPromptEntry[]>(`/companies/${encodeURIComponent(companyId)}/prompts/gateway`),
};
