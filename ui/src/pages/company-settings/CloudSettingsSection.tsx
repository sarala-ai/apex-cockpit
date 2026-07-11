// APEX cloud binding (apex-tower migration — Task 2 §1).
//
// Folds our staged SetupPane discovery UI into a "Cloud" section on Company
// Settings. It does NOT duplicate company/project CRUD — the enclosing page and
// the fork's `projectsApi` own that. Here we:
//   - show gcloud/gh auth status (via the new `/setup/*` routes)
//   - let the operator pick one of the company's products (fork `projects` rows)
//   - bind the GCP projects + GitHub repos that product runs on, persisted into
//     the product's `projects.env` jsonb (no schema change).
//
// Org modeling stays minimal per the doc: a single implicit Org "Sarala"; a
// company row = one of our GCP-backed products; no `orgs` table.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Cloud, Github, XCircle } from "lucide-react";
import type { Project } from "@paperclipai/shared";
import {
  apexSetupApi,
  readCloudBinding,
  writeCloudBinding,
  type GcpProject,
  type GhRepo,
} from "../../api/apex-setup";
import { projectsApi } from "../../api/projects";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/apex/status-badge";

function AuthRow({ ok, label, who }: { ok: boolean; label: string; who: string | null }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      ) : (
        <XCircle className="h-4 w-4 text-destructive" />
      )}
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{ok ? who : "not authenticated"}</span>
    </div>
  );
}

function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function CloudSettingsSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [selProjects, setSelProjects] = useState<Set<string>>(new Set());
  const [selRepos, setSelRepos] = useState<Set<string>>(new Set());
  const [dirtyFor, setDirtyFor] = useState<string | null>(null);

  const authQuery = useQuery({
    queryKey: ["apex-setup", "auth"],
    queryFn: () => apexSetupApi.auth(),
  });
  const gcpProjectsQuery = useQuery({
    queryKey: ["apex-setup", "gcp-projects"],
    queryFn: () => apexSetupApi.gcpProjects(),
  });
  const reposQuery = useQuery({
    queryKey: ["apex-setup", "github-repos"],
    queryFn: () => apexSetupApi.githubRepos(""),
  });
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });

  const projects: Project[] = projectsQuery.data ?? [];
  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  // Sync the binding editor to the chosen product (once, when selection changes).
  function selectProject(id: string) {
    setSelectedProjectId(id);
    const project = projects.find((p) => p.id === id) ?? null;
    const binding = readCloudBinding(project?.env);
    setSelProjects(new Set(binding.gcpProjects));
    setSelRepos(new Set(binding.githubRepos));
    setDirtyFor(null);
  }

  const saveMutation = useMutation({
    mutationFn: (project: Project) =>
      projectsApi.update(
        project.id,
        {
          env: writeCloudBinding(project.env, {
            gcpProjects: [...selProjects],
            githubRepos: [...selRepos],
          }),
        },
        companyId,
      ),
    onSuccess: () => {
      setDirtyFor(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(companyId) });
    },
  });

  const gcpProjects: GcpProject[] = gcpProjectsQuery.data?.projects ?? [];
  const repos: GhRepo[] = reposQuery.data?.repos ?? [];
  const discoveryNote = gcpProjectsQuery.data?.note ?? reposQuery.data?.note ?? null;

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Cloud
      </div>
      <div className="space-y-4 rounded-md border border-border px-4 py-4">
        <p className="text-sm text-muted-foreground">
          Bind this company&apos;s products to the Google Cloud projects and GitHub
          repositories they run on. Discovery reads your local <code>gcloud</code> /{" "}
          <code>gh</code> auth; nothing is provisioned here.
        </p>

        {/* Auth status */}
        <div className="space-y-1.5">
          <AuthRow
            ok={!!authQuery.data?.google.authed}
            label="Google Cloud"
            who={authQuery.data?.google.account ?? null}
          />
          <AuthRow
            ok={!!authQuery.data?.github.authed}
            label="GitHub"
            who={authQuery.data?.github.user ?? null}
          />
        </div>

        {/* Product picker */}
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="text-muted-foreground">Product</span>
            <select
              value={selectedProjectId}
              onChange={(e) => selectProject(e.target.value)}
              className="mt-1 w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
            >
              <option value="">Select a product…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {projects.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No products yet. Create one under Projects first.
            </p>
          )}
        </div>

        {selectedProject && (
          <div className="space-y-3">
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
                      setDirtyFor(selectedProject.id);
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
                      setDirtyFor(selectedProject.id);
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

            {/* Current binding summary */}
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

            {dirtyFor === selectedProject.id && (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate(selectedProject)}
                  disabled={saveMutation.isPending}
                >
                  {saveMutation.isPending ? "Saving…" : "Save binding"}
                </Button>
                {saveMutation.isError && (
                  <span className="text-xs text-destructive">
                    {saveMutation.error instanceof Error
                      ? saveMutation.error.message
                      : "Failed to save binding"}
                  </span>
                )}
              </div>
            )}
            {saveMutation.isSuccess && dirtyFor === null && (
              <span className="text-xs text-muted-foreground">Saved</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
