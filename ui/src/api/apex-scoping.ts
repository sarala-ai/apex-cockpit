// APEX Org + cloud-scope client (apex-tower §1).
//
// Talks to the Express `/api/orgs` + `/api/apex/scope/*` routes: the persisted
// Org entity and org/company-level GCP-project + repo scoping (the resolver's
// org → company → project cascade). Product/project-level binding stays in
// `apex-setup`'s CloudBinding.

import { api } from "./client";

export interface Org {
  id: string;
  name: string;
  googleOrg?: { id: string; displayName: string } | null;
  githubOrg?: string | null;
  createdAt?: string;
}

export interface ScopeCloudBinding {
  scopeType: "org" | "company";
  scopeId: string;
  gcpProjects: string[];
  githubRepos: string[];
}

export const orgsApi = {
  list: () => api.get<{ orgs: Org[] }>("/orgs"),
  get: (id: string) => api.get<{ org: Org }>(`/orgs/${id}`),
  create: (body: { name: string; googleOrg?: Org["googleOrg"]; githubOrg?: string | null }) =>
    api.post<{ org: Org }>("/orgs", body),
  linkCompany: (orgId: string, companyId: string) =>
    api.post<{ company: { id: string; name: string; orgId: string | null } }>(
      `/orgs/${orgId}/companies`,
      { companyId },
    ),
  companies: (orgId: string) =>
    api.get<{ companies: { id: string; name: string; orgId: string | null }[] }>(
      `/orgs/${orgId}/companies`,
    ),
};

export const scopeBindingApi = {
  get: (scopeType: "org" | "company", scopeId: string) =>
    api.get<ScopeCloudBinding>(`/apex/scope/${scopeType}/${scopeId}/cloud-binding`),
  put: (
    scopeType: "org" | "company",
    scopeId: string,
    body: { gcpProjects: string[]; githubRepos: string[] },
  ) => api.put<ScopeCloudBinding>(`/apex/scope/${scopeType}/${scopeId}/cloud-binding`, body),
};
