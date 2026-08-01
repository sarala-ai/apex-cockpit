// Workflows — the AI Governance read surface over apex-core's workflow
// catalog (`apex workflows list`): every workflow the CLI can see, grouped by
// layer (built-in / user / project), with shadowing called out. Detail lives
// on WorkflowDetail.tsx, linked per row. Fed by GET /apex/workflows
// (server/src/routes/apex-workflows.ts) — the core CLI this reads is
// unreleased as of this page landing, so a degraded response
// ({status:"error",error_type:"cli_missing_command",...}) is an everyday
// state, not a crash path: see `WorkflowsErrorState`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, GitCompare, Layers, RefreshCw, Workflow as WorkflowIcon } from "lucide-react";
import { Link } from "@/lib/router";
import { workflowsApi } from "@/api/workflows";
import { capabilitySyncApi } from "@/api/capability-sync";
import { useCompany } from "../context/CompanyContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type {
  CapabilitySyncStatusResponse,
  WorkflowError,
  WorkflowLayer,
  WorkflowListResponse,
  WorkflowSummary,
} from "@paperclipai/shared";

const LAYER_ORDER: WorkflowLayer[] = ["built-in", "user", "project"];
const LAYER_LABEL: Record<WorkflowLayer, string> = {
  "built-in": "Built-in",
  user: "User",
  project: "Project",
};
const LAYER_HINT: Record<WorkflowLayer, string> = {
  "built-in": "Ships with apex-core.",
  user: "From ~/.apex/workflows — this machine's user overrides.",
  project: "From this project's .apex/workflows — closest to the code.",
};

export function WorkflowsErrorState({ error }: { error: WorkflowError }) {
  return (
    <Card>
      <CardContent className="space-y-1.5 py-4">
        <p className="flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error.message}
        </p>
        <p className="pl-6 text-xs text-muted-foreground">
          <span className="font-mono">{error.error_type}</span>
          {error.remediation ? <> — {error.remediation}</> : null}
        </p>
      </CardContent>
    </Card>
  );
}

function ShadowBadges({ workflow }: { workflow: WorkflowSummary }) {
  return (
    <>
      {workflow.shadowed_count > 0 && (
        <Badge
          variant="outline"
          title={`Shadows ${workflow.shadowed_count} workflow(s) of the same name in other layer(s).`}
        >
          shadows {workflow.shadowed_count}
        </Badge>
      )}
      {workflow.shadows_other_layer && (
        <Badge
          variant="outline"
          className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
          title="This workflow is itself shadowed by a higher-precedence layer."
        >
          shadowed
        </Badge>
      )}
    </>
  );
}

function LayerGroup({ layer, workflows }: { layer: WorkflowLayer; workflows: WorkflowSummary[] }) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Layers className="h-4 w-4 text-muted-foreground" />
        <CardTitle className="text-base">{LAYER_LABEL[layer]}</CardTitle>
        <span className="text-xs text-muted-foreground">{LAYER_HINT[layer]}</span>
      </CardHeader>
      <CardContent>
        {workflows.length === 0 ? (
          <p className="text-xs text-muted-foreground">No {LAYER_LABEL[layer].toLowerCase()} workflows.</p>
        ) : (
          <ul className="space-y-1.5">
            {workflows.map((w) => (
              <li key={w.name}>
                <Link
                  to={`/workflows/${encodeURIComponent(w.name)}`}
                  className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-accent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="truncate font-medium" title={w.path}>
                      {w.name}
                    </span>
                    <span className="ml-2 text-muted-foreground">{w.lifecycle}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <ShadowBadges workflow={w} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Updates/diverged banner strip (spec: capability sync + PATH-canonical
 * resolution, Session B / T4). Fed by GET /apex/capabilities/sync — the last
 * summary the periodic `apex capabilities sync` job holds in memory, not a
 * live CLI call on every page load. Honest empty/degraded states:
 *   - never run yet (`status` undefined/null summary) → renders nothing.
 *   - the installed CLI predates `capabilities sync`
 *     (`error_type: "cli_missing_command"`) → renders nothing, no error
 *     spam (this is an everyday condition until Session A's T1 CLI ships,
 *     same posture as WorkflowsErrorState for the workflows CLI itself).
 *   - a real sync error (any other error_type) → a warning strip.
 *   - a clean success with nothing diverged/pending → renders nothing (a
 *     routine sync isn't noteworthy).
 *   - diverged items and/or skills pending `--accept-skills` → the banner.
 */
export function CapabilitySyncBanner({
  status,
  onRefresh,
  refreshing,
}: {
  status: CapabilitySyncStatusResponse | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  if (!status?.summary) return null;
  const { summary, ranAt } = status;

  const RefreshButton = onRefresh ? (
    <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={refreshing} className="h-6 gap-1.5 px-2 text-xs">
      <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
      {refreshing ? "Syncing…" : "Refresh"}
    </Button>
  ) : null;

  if (summary.status === "error") {
    if (summary.error_type === "cli_missing_command") return null;
    return (
      <Card className="border-rose-500/30 bg-rose-500/5" data-testid="capability-sync-banner">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-xs">
          <span className="flex items-center gap-2 text-rose-600 dark:text-rose-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Capability sync failed: {summary.message}
          </span>
          {RefreshButton}
        </CardContent>
      </Card>
    );
  }

  const divergedCount = summary.diverged.length;
  const pendingCount = summary.pending_skills.length;
  if (divergedCount === 0 && pendingCount === 0) return null;

  return (
    <Card className="border-amber-500/30 bg-amber-500/5" data-testid="capability-sync-banner">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-xs">
        <span className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
          <GitCompare className="h-3.5 w-3.5 shrink-0" />
          {divergedCount > 0 && (
            <span>
              {divergedCount} diverged item{divergedCount === 1 ? "" : "s"} (local edits kept, not overwritten)
            </span>
          )}
          {divergedCount > 0 && pendingCount > 0 && <span aria-hidden>·</span>}
          {pendingCount > 0 && (
            <span>
              {pendingCount} skill update{pendingCount === 1 ? "" : "s"} pending review (
              <span className="font-mono">--accept-skills</span>)
            </span>
          )}
        </span>
        <span className="flex items-center gap-2 text-muted-foreground">
          <span title={ranAt ?? undefined}>synced {ranAt ? new Date(ranAt).toLocaleString() : "—"}</span>
          {RefreshButton}
        </span>
      </CardContent>
    </Card>
  );
}

export function WorkflowsBody({
  isLoading,
  data,
  capabilitySync,
  onRefreshCapabilitySync,
  refreshingCapabilitySync,
}: {
  isLoading: boolean;
  data: WorkflowListResponse | undefined;
  capabilitySync?: CapabilitySyncStatusResponse;
  onRefreshCapabilitySync?: () => void;
  refreshingCapabilitySync?: boolean;
}) {
  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workflows…</div>;
  }

  if (!data || data.status === "error") {
    return (
      <div className="space-y-4 p-4">
        <Header />
        <CapabilitySyncBanner status={capabilitySync} onRefresh={onRefreshCapabilitySync} refreshing={refreshingCapabilitySync} />
        <WorkflowsErrorState
          error={
            data ?? {
              status: "error",
              error_type: "cli_missing_command",
              message: "requires apex-platform with the workflows CLI (unreleased)",
              remediation: null,
            }
          }
        />
      </div>
    );
  }

  const byLayer = new Map<WorkflowLayer, WorkflowSummary[]>();
  for (const layer of LAYER_ORDER) byLayer.set(layer, []);
  for (const w of data.workflows) {
    const bucket = byLayer.get(w.layer);
    if (bucket) bucket.push(w);
    else byLayer.set(w.layer, [w]);
  }

  return (
    <div className="space-y-4 p-4">
      <Header count={data.workflows.length} />
      <CapabilitySyncBanner status={capabilitySync} onRefresh={onRefreshCapabilitySync} refreshing={refreshingCapabilitySync} />
      {data.workflows.length === 0 ? (
        <Card>
          <CardContent className="py-4 text-xs text-muted-foreground">
            No workflows found in any layer.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {LAYER_ORDER.map((layer) => (
            <LayerGroup key={layer} layer={layer} workflows={byLayer.get(layer) ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}

function Header({ count }: { count?: number }) {
  return (
    <div>
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        <WorkflowIcon className="h-5 w-5" />
        Workflows
        {typeof count === "number" && <span className="text-sm font-normal text-muted-foreground">({count})</span>}
      </h1>
      <p className="text-sm text-muted-foreground">
        apex-core's workflow catalog — what's runnable, by layer, and what shadows what.
      </p>
    </div>
  );
}

export function Workflows() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["apex", "workflows", selectedCompanyId],
    queryFn: () => workflowsApi.list(selectedCompanyId),
  });

  const capabilitySyncStatusKey = ["apex", "capabilities", "sync"] as const;
  const capabilitySync = useQuery({
    queryKey: capabilitySyncStatusKey,
    queryFn: capabilitySyncApi.status,
  });

  const refresh = useMutation({
    mutationFn: capabilitySyncApi.sync,
    onSuccess: (data) => {
      queryClient.setQueryData(capabilitySyncStatusKey, data);
    },
  });

  return (
    <WorkflowsBody
      isLoading={list.isLoading}
      data={list.data}
      capabilitySync={capabilitySync.data}
      onRefreshCapabilitySync={() => refresh.mutate()}
      refreshingCapabilitySync={refresh.isPending}
    />
  );
}
