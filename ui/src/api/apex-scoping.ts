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

/** owner | admin | member (reviewer/observer reserved for future read-only tiers). */
export type OrgRole = "owner" | "admin" | "member";

export interface OrgMembership {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole | string;
  status: "active" | "pending" | string;
  createdAt?: string;
  updatedAt?: string;
}

export const orgsApi = {
  list: () => api.get<{ orgs: Org[] }>("/orgs"),
  get: (id: string) => api.get<{ org: Org }>(`/orgs/${id}`),
  create: (body: { name: string; googleOrg?: Org["googleOrg"]; githubOrg?: string | null }) =>
    api.post<{ org: Org; membership: OrgMembership | null }>("/orgs", body),
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

export const orgMembershipApi = {
  list: (orgId: string) =>
    api.get<{ members: OrgMembership[] }>(`/orgs/${orgId}/members`),
  mine: (orgId: string) =>
    api.get<{ membership: OrgMembership | null }>(`/orgs/${orgId}/membership`),
  // Self-service request-access (pending member); an owner/admin may pass
  // { userId, role, status } to map another user directly.
  request: (orgId: string, body?: { userId?: string; role?: OrgRole; status?: "active" | "pending" }) =>
    api.post<{ membership: OrgMembership | null }>(`/orgs/${orgId}/members`, body ?? {}),
  approve: (orgId: string, userId: string) =>
    api.post<{ membership: OrgMembership }>(`/orgs/${orgId}/members/${userId}/approve`, {}),
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
