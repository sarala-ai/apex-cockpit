// APEX cloud/account discovery client (apex-tower migration — Task 2 §1).
//
// Talks to the Express `/api/setup/*` routes (server/src/routes/apex-setup.ts),
// a 1:1 port of our staged Fastify discovery endpoints. Read-only: it lists the
// GCP projects/orgs + GitHub orgs/repos the locally-authed gcloud/gh accounts
// can see. Company/product CRUD is NOT here — the Setup UI uses the fork's
// `companiesApi`/`projectsApi` for that.
//
// The GCP-project / GitHub-repo binding for a product lands in the fork's
// `projects.env` jsonb (the doc's chosen extension point, no migration). Because
// `env` is a secret-binding map (`Record<string, EnvBinding>`), we encode our
// two string arrays as plain-string values under reserved `__apex_*` keys — this
// is schema-valid, round-trips through secret normalization untouched, and keeps
// the binding out of the way of real env vars.

import type { AgentEnvConfig } from "@paperclipai/shared";
import { api } from "./client";

type AuthHealth = "ok" | "missing" | "expired";

export interface AuthStatus {
  // `authed` = account configured; `live` = token currently usable (not expired).
  // authed-but-not-live drives the UI's "session expired, re-authenticate" prompt.
  google: { authed: boolean; account: string | null; live: boolean };
  github: { authed: boolean; user: string | null; live: boolean };
  gcloud: AuthHealth;
  gh: AuthHealth;
  adc: AuthHealth;
  // "server" = cockpit runs on the operator's own machine and probed itself;
  // "workstation" = the desktop app / `apex doctor --report` last reported
  // (within the max report age); "stale" = a report exists but is too old to
  // trust; "none" = hosted cockpit, this operator has never reported (unknown,
  // not failing).
  source: "server" | "workstation" | "stale" | "none";
  reportedAt: string | null;
  /** Milliseconds since the workstation report; null for "server"/"none". */
  reportAgeMs: number | null;
}

/** Carried on the four discovery responses below when a hosted cockpit can't
 *  shell out to gcloud/gh itself — discovery only runs on the operator's
 *  workstation there. */
export type DiscoveryReason = "operator_workstation_required";

export interface DiscoveryWorkstation {
  reportedAt: string;
  gcloud: { account: string | null; live: boolean };
  gh: { user: string | null };
}
export interface GcpProject {
  projectId: string;
  name: string;
  projectNumber: string;
}
export interface GcpOrg {
  id: string;
  displayName: string;
}
export interface GhOrg {
  login: string;
  id: number;
}
export interface GhRepo {
  name: string;
  nameWithOwner: string;
  visibility: string;
  url: string;
}

export const apexSetupApi = {
  auth: () => api.get<AuthStatus>("/setup/auth"),
  workstationReport: () =>
    api.get<{ report: unknown; reportedAt: string | null }>("/setup/workstation-report"),
  gcpProjects: () =>
    api.get<{
      projects: GcpProject[];
      source: string;
      note?: string;
      reason?: DiscoveryReason;
      workstation?: DiscoveryWorkstation | null;
    }>("/setup/gcp/projects"),
  gcpOrgs: () =>
    api.get<{
      orgs: GcpOrg[];
      source: string;
      note?: string;
      reason?: DiscoveryReason;
      workstation?: DiscoveryWorkstation | null;
    }>("/setup/gcp/orgs"),
  githubOrgs: () =>
    api.get<{
      orgs: GhOrg[];
      source: string;
      note?: string;
      reason?: DiscoveryReason;
      workstation?: DiscoveryWorkstation | null;
    }>("/setup/github/orgs"),
  githubRepos: (org: string) =>
    api.get<{
      repos: GhRepo[];
      source: string;
      note?: string;
      reason?: DiscoveryReason;
      workstation?: DiscoveryWorkstation | null;
    }>(`/setup/github/repos${org ? `?org=${encodeURIComponent(org)}` : ""}`),
};

// --- GCP/repo binding on projects.env (no migration) ------------------------

export const APEX_GCP_PROJECTS_KEY = "__apex_gcp_projects";
export const APEX_GITHUB_REPOS_KEY = "__apex_github_repos";

export interface CloudBinding {
  gcpProjects: string[];
  githubRepos: string[];
}

function decodeStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function bindingSlotToString(value: unknown): string | undefined {
  // env bindings can be a bare string or a `{ type: "plain", value }` object.
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    return typeof inner === "string" ? inner : undefined;
  }
  return undefined;
}

/** Read the APEX cloud binding out of a project's `env` jsonb. */
export function readCloudBinding(env: AgentEnvConfig | null | undefined): CloudBinding {
  const record = (env ?? {}) as Record<string, unknown>;
  return {
    gcpProjects: decodeStringArray(bindingSlotToString(record[APEX_GCP_PROJECTS_KEY])),
    githubRepos: decodeStringArray(bindingSlotToString(record[APEX_GITHUB_REPOS_KEY])),
  };
}

/**
 * Merge an APEX cloud binding into an existing `env` map, preserving any real
 * env vars. Returns the value to PATCH onto `projects.env`.
 */
export function writeCloudBinding(
  env: AgentEnvConfig | null | undefined,
  binding: CloudBinding,
): AgentEnvConfig {
  const next: Record<string, unknown> = { ...(env ?? {}) };
  next[APEX_GCP_PROJECTS_KEY] = JSON.stringify(binding.gcpProjects);
  next[APEX_GITHUB_REPOS_KEY] = JSON.stringify(binding.githubRepos);
  return next as AgentEnvConfig;
}
