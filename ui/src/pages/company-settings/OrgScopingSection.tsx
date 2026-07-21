// APEX Org + org/company cloud scoping (apex-tower §1 · onboarding wizard step 3).
//
// The org → company scoping surface that sits ABOVE product-level binding
// (CloudSettingsSection). It persists the Org entity and GCP-project + repo
// bindings at ORG and COMPANY scope (`cloud_scope_bindings`), reusing the same
// gcloud/gh discovery as the product-level Cloud section. This is the resolver's
// org → company cascade made operable in the UI.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Cloud, Github } from "lucide-react";
import { apexSetupApi, type GcpProject, type GhRepo } from "../../api/apex-setup";
import { orgsApi, scopeBindingApi, type GovernancePosture } from "../../api/apex-scoping";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/apex/status-badge";

/** The signed-in user's GitHub orgs, for the "map to a GitHub org" selector on
 *  create. Not fetched until the create form actually needs it (no org yet). */
function useGithubOrgOptions(enabled: boolean) {
  return useQuery({
    queryKey: ["apex-setup", "github-orgs"],
    queryFn: () => apexSetupApi.githubOrgs(),
    enabled,
  });
}

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Normalize to an alnum-only token for loose convention matching. */
export function conventionToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Loose, ADVISORY convention match: which of `names` belong to `companyName` by
 * naming (`FinPilot` ↔ `finpilot-dev`, `finpilot_mcp`, `sarala-ai/finpilot-api`).
 * This only SUGGESTS a company↔resource association for the user to confirm — it
 * never enforces anything (access is governed by IAM/WIF for projects and GitHub
 * grants for repos). Match on the resource's leading token, or a full-leaf prefix.
 */
export function suggestByConvention(names: string[], companyName: string): string[] {
  const token = conventionToken(companyName);
  if (!token) return [];
  return names.filter((n) => {
    const leaf = n.includes("/") ? (n.split("/").pop() ?? n) : n;
    const leadingSeg = leaf.split(/[-_./]/)[0] ?? leaf;
    return conventionToken(leadingSeg) === token || conventionToken(leaf).startsWith(token);
  });
}

/** A GCP-project + repo multi-select bound to one scope (org|company). */
function ScopeBindingEditor({
  scopeType,
  scopeId,
  label,
  testId,
  gcpProjects,
  repos,
  discoveryNote,
  suggestForName,
}: {
  scopeType: "org" | "company";
  scopeId: string;
  label: string;
  testId: string;
  gcpProjects: GcpProject[];
  repos: GhRepo[];
  discoveryNote: string | null;
  /** Company name (company scope) → drives loose convention suggestions. */
  suggestForName?: string;
}) {
  const queryClient = useQueryClient();
  const bindingQuery = useQuery({
    queryKey: ["apex-scope-binding", scopeType, scopeId],
    queryFn: () => scopeBindingApi.get(scopeType, scopeId),
  });

  const [selProjects, setSelProjects] = useState<Set<string>>(new Set());
  const [selRepos, setSelRepos] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);

  // Load the server-side binding into the editor when it (or the scope) changes.
  useEffect(() => {
    if (!bindingQuery.data) return;
    setSelProjects(new Set(bindingQuery.data.gcpProjects));
    setSelRepos(new Set(bindingQuery.data.githubRepos));
    setDirty(false);
  }, [bindingQuery.data, scopeId]);

  const saveMutation = useMutation({
    mutationFn: () =>
      scopeBindingApi.put(scopeType, scopeId, {
        gcpProjects: [...selProjects],
        githubRepos: [...selRepos],
      }),
    onSuccess: () => {
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["apex-scope-binding", scopeType, scopeId] });
      // The scope binding feeds the setup-state detector (orgCloud/companyCloud/
      // companyRepos steps + the status bar) — refresh it live, not on reload.
      void queryClient.invalidateQueries({ queryKey: ["setup-state"] });
    },
  });

  // Loose convention suggestions (company scope only): projects/repos whose names
  // match the company. Advisory — the user confirms; nothing is auto-bound.
  const suggestedProjects = suggestForName
    ? suggestByConvention(gcpProjects.map((p) => p.projectId), suggestForName)
    : [];
  const suggestedRepos = suggestForName
    ? suggestByConvention(repos.map((r) => r.nameWithOwner), suggestForName)
    : [];
  const pendingSuggested = [
    ...suggestedProjects.filter((p) => !selProjects.has(p)),
    ...suggestedRepos.filter((r) => !selRepos.has(r)),
  ];
  const addSuggested = () => {
    setSelProjects((s) => {
      const next = new Set(s);
      suggestedProjects.forEach((p) => next.add(p));
      return next;
    });
    setSelRepos((s) => {
      const next = new Set(s);
      suggestedRepos.forEach((r) => next.add(r));
      return next;
    });
    setDirty(true);
  };

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-3" data-testid={testId}>
      <div className="text-sm font-medium">{label}</div>

      {suggestForName && pendingSuggested.length > 0 && (
        <div
          data-testid="apex-scope-suggestions"
          className="flex flex-wrap items-center gap-2 rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5 text-xs"
        >
          <span className="text-sky-700 dark:text-sky-300">
            Suggested for <strong>{suggestForName}</strong> by naming:{" "}
            {pendingSuggested.map((n) => n.split("/").pop()).join(", ")}
          </span>
          <Button size="sm" variant="outline" data-testid="apex-scope-add-suggested" onClick={addSuggested}>
            Add suggested
          </Button>
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Cloud className="h-3.5 w-3.5" /> GCP projects
        </div>
        <div className="flex flex-wrap gap-1.5">
          {gcpProjects.length === 0 && (
            <span className="text-xs text-muted-foreground">
              {discoveryNote ?? "No GCP projects visible."}
            </span>
          )}
          {gcpProjects.map((p) => (
            <button
              key={p.projectId}
              type="button"
              onClick={() => {
                setSelProjects((s) => toggle(s, p.projectId));
                setDirty(true);
              }}
              className={`rounded border px-1.5 py-0.5 text-xs ${
                selProjects.has(p.projectId)
                  ? "border-sky-500/50 bg-sky-500/20 text-sky-600 dark:text-sky-200"
                  : "border-border text-muted-foreground"
              }`}
            >
              {p.projectId}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Github className="h-3.5 w-3.5" /> Repositories
        </div>
        <div className="flex flex-wrap gap-1.5">
          {repos.length === 0 && (
            <span className="text-xs text-muted-foreground">No repositories visible.</span>
          )}
          {repos.map((r) => (
            <button
              key={r.nameWithOwner}
              type="button"
              onClick={() => {
                setSelRepos((s) => toggle(s, r.nameWithOwner));
                setDirty(true);
              }}
              className={`rounded border px-1.5 py-0.5 text-xs ${
                selRepos.has(r.nameWithOwner)
                  ? "border-sky-500/50 bg-sky-500/20 text-sky-600 dark:text-sky-200"
                  : "border-border text-muted-foreground"
              }`}
            >
              {r.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {[...selProjects].map((p) => (
          <StatusBadge key={p} variant="info">
            {p}
          </StatusBadge>
        ))}
        {[...selRepos].map((r) => (
          <StatusBadge key={r} variant="default">
            {r.split("/").pop()}
          </StatusBadge>
        ))}
      </div>

      {dirty && (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save binding"}
          </Button>
          {saveMutation.isError && (
            <span className="text-xs text-destructive">
              {saveMutation.error instanceof Error ? saveMutation.error.message : "Failed to save"}
            </span>
          )}
        </div>
      )}
      {saveMutation.isSuccess && !dirty && (
        <span className="text-xs text-muted-foreground">Saved</span>
      )}
    </div>
  );
}

/**
 * Which slice of the org→company scoping surface to render. The standalone
 * CompanySettings page uses `"all"` (create org + both scope editors). The
 * onboarding wizard embeds one slice per step: `"org"` (create/summary/link),
 * `"orgScope"` (org GCP+repo binding), `"companyScope"` (company GCP+repo binding).
 */
export type OrgScopingSlice = "all" | "org" | "orgScope" | "companyScope";

export function OrgScopingSection({
  companyId,
  slice = "all",
}: {
  companyId?: string;
  slice?: OrgScopingSlice;
}) {
  const queryClient = useQueryClient();
  const [newOrgName, setNewOrgName] = useState("Sarala");
  const [newGithubOrg, setNewGithubOrg] = useState("");
  // Post-create GitHub-org editing (an org may exist with no mapping).
  const [editingGithubOrg, setEditingGithubOrg] = useState(false);
  const [githubOrgDraft, setGithubOrgDraft] = useState("");

  const orgsQuery = useQuery({ queryKey: ["apex-orgs"], queryFn: () => orgsApi.list() });
  // The signed-in user's GitHub orgs — needed for the create-org form (no org
  // yet) AND when editing an existing org's mapping. We scope repo discovery to
  // this GitHub org so pickers show the org's repos, not personal ones.
  const githubOrgsQuery = useGithubOrgOptions(
    (!orgsQuery.data?.orgs.length && orgsQuery.isSuccess) || editingGithubOrg,
  );
  const gcpProjectsQuery = useQuery({
    queryKey: ["apex-setup", "gcp-projects"],
    queryFn: () => apexSetupApi.gcpProjects(),
  });

  // Single holding-Org model for now: the first org is "the org".
  const org = orgsQuery.data?.orgs[0] ?? null;

  // Scope repo discovery to the org's GitHub org (when known) instead of the
  // signed-in user's personal repos — both the org and company scope editors
  // should offer repos from the org's GitHub, not the individual's account.
  // Only fire once the orgs list has resolved, so we don't fetch the
  // unscoped/personal list first and flash it before the scoped list lands.
  const reposQuery = useQuery({
    queryKey: ["apex-setup", "github-repos", org?.githubOrg ?? null],
    queryFn: () => apexSetupApi.githubRepos(org?.githubOrg ?? ""),
    enabled: orgsQuery.isSuccess,
  });

  const createOrg = useMutation({
    mutationFn: (args: { name: string; githubOrg?: string }) =>
      orgsApi.create({ name: args.name, githubOrg: args.githubOrg || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apex-orgs"] });
      // Org presence feeds the setup-state detector (the "org" step + status
      // bar) — refresh it live, not on reload.
      void queryClient.invalidateQueries({ queryKey: ["setup-state"] });
    },
  });

  const updateGithubOrg = useMutation({
    mutationFn: (githubOrg: string | null) => orgsApi.update(org!.id, { githubOrg }),
    onSuccess: () => {
      setEditingGithubOrg(false);
      void queryClient.invalidateQueries({ queryKey: ["apex-orgs"] });
      // Re-run repo discovery (its key includes the githubOrg) so pickers reflect
      // the new mapping immediately.
      void queryClient.invalidateQueries({ queryKey: ["apex-setup", "github-repos"] });
    },
  });

  const updatePosture = useMutation({
    mutationFn: (governancePosture: GovernancePosture) =>
      orgsApi.update(org!.id, { governancePosture }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["apex-orgs"] });
      // Posture drives the wizard's required steps + the "No GitHub org" warning —
      // refresh the detector so both update live.
      void queryClient.invalidateQueries({ queryKey: ["setup-state"] });
    },
  });

  const companiesQuery = useQuery({
    queryKey: ["apex-org-companies", org?.id],
    queryFn: () => orgsApi.companies(org!.id),
    enabled: !!org,
  });

  const linkCompany = useMutation({
    // Only invoked from the summary's "Add this company" button, which renders
    // only when companyId is set.
    mutationFn: () => orgsApi.linkCompany(org!.id, companyId!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["apex-org-companies", org?.id] }),
  });

  const gcpProjects: GcpProject[] = gcpProjectsQuery.data?.projects ?? [];
  const repos: GhRepo[] = reposQuery.data?.repos ?? [];
  const discoveryNote = gcpProjectsQuery.data?.note ?? reposQuery.data?.note ?? null;
  const companies = companiesQuery.data?.companies ?? [];
  const companyLinked = !!companyId && companies.some((c) => c.id === companyId);
  // Governance posture (default individual). Drives whether the missing-GitHub-org
  // warning is a hard warning (team/enterprise, where a mapped org is the boundary)
  // or an expected, informational state (individual — personal repos are fine).
  const posture: GovernancePosture = org?.governancePosture ?? "individual";
  const postureHardened = posture === "team" || posture === "enterprise";
  const companyName = companyId ? companies.find((c) => c.id === companyId)?.name : undefined;

  const showOrgSummary = slice === "all" || slice === "org";
  const showOrgScope = slice === "all" || slice === "orgScope";
  const showCompanyScope = slice === "all" || slice === "companyScope";

  return (
    <div className="space-y-4" data-testid="apex-org-section" data-slice={slice}>
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Organization &amp; scoping
      </div>
      <div className="space-y-4 rounded-md border border-border px-4 py-4">
        {slice === "all" && (
          <p className="text-sm text-muted-foreground">
            Group companies under a holding <strong>Org</strong> and scope GCP projects
            &amp; repos at the org and company levels — the org → company → product
            cascade APEX resolves.
          </p>
        )}

        {!org ? (
          showOrgSummary ? (
            <div className="space-y-2" data-testid="apex-org-create">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" /> No org yet — create the holding entity
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  data-testid="apex-org-name-input"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="Org name (e.g. Sarala)"
                  className="w-48 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none"
                />
                <select
                  data-testid="apex-org-github-org-select"
                  value={newGithubOrg}
                  onChange={(e) => setNewGithubOrg(e.target.value)}
                  className="rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none"
                >
                  <option value="">No GitHub org (personal repos)</option>
                  {(githubOrgsQuery.data?.orgs ?? []).map((o) => (
                    <option key={o.login} value={o.login}>
                      {o.login}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  onClick={() => createOrg.mutate({ name: newOrgName.trim(), githubOrg: newGithubOrg })}
                  disabled={createOrg.isPending || newOrgName.trim().length === 0}
                >
                  {createOrg.isPending ? "Creating…" : "Create org"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Map to a GitHub org so org/company-scoped repo pickers show the org’s repos, not
                your personal ones.
              </p>
              {createOrg.isError && (
                <span className="text-xs text-destructive">
                  {createOrg.error instanceof Error ? createOrg.error.message : "Failed to create org"}
                </span>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="apex-org-needed">
              Create the org first (the “Create Org” step) — this scope binding appears once it exists.
            </p>
          )
        ) : (
          <>
            {/* GitHub-org mapping. When absent, repo pickers fall back to the
                signed-in user's personal repos — warn + offer to set it. */}
            <div data-testid="apex-org-github-mapping">
              {org.githubOrg ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Github className="h-3.5 w-3.5" />
                  <span>
                    GitHub org:{" "}
                    <span className="font-medium text-foreground">{org.githubOrg}</span>
                  </span>
                  <button
                    type="button"
                    data-testid="apex-org-github-change"
                    onClick={() => {
                      setGithubOrgDraft(org.githubOrg ?? "");
                      setEditingGithubOrg(true);
                    }}
                    className="underline transition hover:text-foreground"
                  >
                    change
                  </button>
                </div>
              ) : postureHardened ? (
                <div
                  data-testid="apex-org-no-github-warning"
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
                >
                  <div className="font-medium text-amber-700 dark:text-amber-300">
                    No GitHub org mapped
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    Repo pickers below are falling back to your <strong>personal</strong> repos. Map
                    a GitHub org so org &amp; company repos come from the org.
                  </div>
                  {!editingGithubOrg && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1.5"
                      data-testid="apex-org-github-map"
                      onClick={() => {
                        setGithubOrgDraft("");
                        setEditingGithubOrg(true);
                      }}
                    >
                      Map a GitHub org
                    </Button>
                  )}
                </div>
              ) : (
                // Individual posture — personal repos are expected, so this is an
                // informational note, not a warning. (Dial posture up to require a
                // mapped GitHub org.)
                <div
                  data-testid="apex-org-no-github-info"
                  className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Github className="h-3.5 w-3.5" />
                  <span>
                    Using your <strong>personal</strong> repos. Map a GitHub org anytime.
                  </span>
                  {!editingGithubOrg && (
                    <button
                      type="button"
                      data-testid="apex-org-github-map"
                      onClick={() => {
                        setGithubOrgDraft("");
                        setEditingGithubOrg(true);
                      }}
                      className="underline transition hover:text-foreground"
                    >
                      map one
                    </button>
                  )}
                </div>
              )}

              {editingGithubOrg && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select
                    data-testid="apex-org-github-edit-select"
                    value={githubOrgDraft}
                    onChange={(e) => setGithubOrgDraft(e.target.value)}
                    className="rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none"
                  >
                    <option value="">No GitHub org (personal repos)</option>
                    {(githubOrgsQuery.data?.orgs ?? []).map((o) => (
                      <option key={o.login} value={o.login}>
                        {o.login}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    data-testid="apex-org-github-save"
                    onClick={() => updateGithubOrg.mutate(githubOrgDraft || null)}
                    disabled={updateGithubOrg.isPending}
                  >
                    {updateGithubOrg.isPending ? "Saving…" : "Save"}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setEditingGithubOrg(false)}
                    className="text-xs text-muted-foreground underline"
                  >
                    Cancel
                  </button>
                  {updateGithubOrg.isError && (
                    <span className="text-xs text-destructive">
                      {updateGithubOrg.error instanceof Error
                        ? updateGithubOrg.error.message
                        : "Failed to update"}
                    </span>
                  )}
                </div>
              )}
            </div>

            {showOrgSummary && (
              <div
                className="flex flex-wrap items-center gap-2 text-xs"
                data-testid="apex-org-posture"
              >
                <span className="text-muted-foreground">Governance posture</span>
                <select
                  data-testid="apex-org-posture-select"
                  value={posture}
                  onChange={(e) => updatePosture.mutate(e.target.value as GovernancePosture)}
                  disabled={updatePosture.isPending}
                  className="rounded-md border border-border bg-transparent px-2 py-1 outline-none"
                >
                  <option value="individual">Individual — solo, self-service (default)</option>
                  <option value="team">Team — App install + admin binding</option>
                  <option value="enterprise">Enterprise — full governance</option>
                </select>
                <span className="text-muted-foreground">
                  {postureHardened
                    ? "Hardening on: App-install/WIF + admin-authoritative binding required."
                    : "Loose: personal repos/projects, advisory associations, no App-install/WIF."}
                </span>
              </div>
            )}

            {showOrgSummary && (
              <div className="space-y-1.5" data-testid="apex-org-summary">
                <div className="flex items-center gap-1.5 text-sm">
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{org.name}</span>
                  <span className="text-xs text-muted-foreground">
                    · {companies.length} {companies.length === 1 ? "company" : "companies"}
                  </span>
                </div>
                {companies.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {companies.map((c) => (
                      <StatusBadge key={c.id} variant={c.id === companyId ? "info" : "default"}>
                        {c.name}
                      </StatusBadge>
                    ))}
                  </div>
                )}
                {companyId && !companyLinked && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => linkCompany.mutate()}
                    disabled={linkCompany.isPending}
                    data-testid="apex-org-link-company"
                  >
                    {linkCompany.isPending ? "Adding…" : `Add this company to ${org.name}`}
                  </Button>
                )}
              </div>
            )}

            {showOrgScope && (
              <ScopeBindingEditor
                scopeType="org"
                scopeId={org.id}
                label={`Org scope — ${org.name}`}
                testId="apex-org-scope-binding"
                gcpProjects={gcpProjects}
                repos={repos}
                discoveryNote={discoveryNote}
              />
            )}
            {showCompanyScope &&
              (companyId ? (
                <ScopeBindingEditor
                  scopeType="company"
                  scopeId={companyId}
                  label="Company scope"
                  testId="apex-company-scope-binding"
                  gcpProjects={gcpProjects}
                  repos={repos}
                  discoveryNote={discoveryNote}
                  suggestForName={companyName}
                />
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="apex-company-needed">
                  Select or create a company first (under{" "}
                  <a className="underline" href="/companies">
                    Companies
                  </a>
                  ) — then its GCP/repo binding appears here.
                </p>
              ))}
          </>
        )}
      </div>
    </div>
  );
}
