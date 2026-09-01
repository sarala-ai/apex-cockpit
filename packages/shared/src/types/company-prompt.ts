export interface CompanyPromptVariable {
  name: string;
  description: string | null;
  required: boolean;
}

export interface CompanyPrompt {
  id: string;
  companyId: string;
  name: string;
  slug: string;
  description: string | null;
  currentVersionId: string | null;
  currentVersionNumber: number | null;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyPromptListItem extends CompanyPrompt {
  labelCount: number;
  hasProd: boolean;
}

export interface CompanyPromptDetail extends CompanyPrompt {
  versions: CompanyPromptVersion[];
  labels: CompanyPromptLabel[];
}

export interface CompanyPromptVersion {
  id: string;
  companyId: string;
  promptId: string;
  revisionNumber: number;
  content: string;
  variables: CompanyPromptVariable[];
  commitMessage: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdAt: string;
}

export interface CompanyPromptLabel {
  id: string;
  companyId: string;
  promptId: string;
  name: string;
  versionId: string;
  versionNumber: number;
  protected: boolean;
  updatedByUserId: string | null;
  updatedByAgentId: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface CompanyPromptCreateRequest {
  name: string;
  slug?: string;
  description?: string | null;
  content: string;
  variables?: CompanyPromptVariable[];
  commitMessage?: string | null;
}

export interface CompanyPromptUpdateRequest {
  name?: string;
  description?: string | null;
}

export interface CompanyPromptVersionCreateRequest {
  content: string;
  variables?: CompanyPromptVariable[];
  commitMessage?: string | null;
}

export interface CompanyPromptLabelSetRequest {
  versionId: string;
}

export interface CompanyPromptResolveResult {
  promptId: string;
  promptName: string;
  versionId: string;
  revisionNumber: number;
  content: string;
  variables: CompanyPromptVariable[];
  label: string;
  resolvedAt: string;
}
