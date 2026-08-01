// Workflows — the AI Governance read surface over apex-core's workflow
// catalog (`apex workflows list`): every workflow the CLI can see, grouped by
// layer (built-in / user / project), with shadowing called out. Detail lives
// on WorkflowDetail.tsx, linked per row. Fed by GET /apex/workflows
// (server/src/routes/apex-workflows.ts) — the core CLI this reads is
// unreleased as of this page landing, so a degraded response
// ({status:"error",error_type:"cli_missing_command",...}) is an everyday
// state, not a crash path: see `WorkflowsErrorState`.
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Layers, Workflow as WorkflowIcon } from "lucide-react";
import { Link } from "@/lib/router";
import { workflowsApi } from "@/api/workflows";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WorkflowError, WorkflowLayer, WorkflowListResponse, WorkflowSummary } from "@paperclipai/shared";

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

export function WorkflowsBody({
  isLoading,
  data,
}: {
  isLoading: boolean;
  data: WorkflowListResponse | undefined;
}) {
  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workflows…</div>;
  }

  if (!data || data.status === "error") {
    return (
      <div className="space-y-4 p-4">
        <Header />
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
  const list = useQuery({
    queryKey: ["apex", "workflows"],
    queryFn: workflowsApi.list,
  });

  return <WorkflowsBody isLoading={list.isLoading} data={list.data} />;
}
