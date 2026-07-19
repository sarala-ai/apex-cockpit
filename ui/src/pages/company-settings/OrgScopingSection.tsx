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
import { orgsApi, scopeBindingApi } from "../../api/apex-scoping";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/apex/status-badge";

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
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
}: {
  scopeType: "org" | "company";
  scopeId: string;
  label: string;
  testId: string;
  gcpProjects: GcpProject[];
  repos: GhRepo[];
  discoveryNote: string | null;
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
    },
  });

  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-3" data-testid={testId}>
      <div className="text-sm font-medium">{label}</div>

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

  const orgsQuery = useQuery({ queryKey: ["apex-orgs"], queryFn: () => orgsApi.list() });
  const gcpProjectsQuery = useQuery({
    queryKey: ["apex-setup", "gcp-projects"],
    queryFn: () => apexSetupApi.gcpProjects(),
  });
  const reposQuery = useQuery({
    queryKey: ["apex-setup", "github-repos"],
    queryFn: () => apexSetupApi.githubRepos(""),
  });

  // Single holding-Org model for now: the first org is "the org".
  const org = orgsQuery.data?.orgs[0] ?? null;

  const createOrg = useMutation({
    mutationFn: (name: string) => orgsApi.create({ name }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["apex-orgs"] }),
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
              <div className="flex items-center gap-2">
                <input
                  data-testid="apex-org-name-input"
                  value={newOrgName}
                  onChange={(e) => setNewOrgName(e.target.value)}
                  placeholder="Org name (e.g. Sarala)"
                  className="w-48 rounded-md border border-border bg-transparent px-2.5 py-1 text-sm outline-none"
                />
                <Button
                  size="sm"
                  onClick={() => createOrg.mutate(newOrgName.trim())}
                  disabled={createOrg.isPending || newOrgName.trim().length === 0}
                >
                  {createOrg.isPending ? "Creating…" : "Create org"}
                </Button>
              </div>
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
