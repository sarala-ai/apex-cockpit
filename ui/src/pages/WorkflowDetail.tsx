// Workflow detail — one workflow's definition (inputs, ordered steps, raw
// YAML) plus its footprint: resources this cockpit's resource_attributions
// table has recorded as belonging to it. Fed by GET /apex/workflows/:name
// (server/src/routes/apex-workflows.ts). Same degraded-CLI honesty as
// Workflows.tsx — see WorkflowsErrorState.
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Boxes } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { workflowsApi } from "@/api/workflows";
import { WorkflowsErrorState } from "./Workflows";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { WorkflowDetailResponse } from "@paperclipai/shared";

function BackLink() {
  return (
    <Link to="/workflows" className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
      <ArrowLeft className="h-3 w-3" />
      Back to Workflows
    </Link>
  );
}

export function WorkflowDetailBody({
  isLoading,
  data,
}: {
  isLoading: boolean;
  data: WorkflowDetailResponse | undefined;
}) {
  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading workflow…</div>;
  }

  if (!data || data.status === "error") {
    return (
      <div className="space-y-4 p-4">
        <BackLink />
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

  const { footprint } = data;

  return (
    <div className="space-y-4 p-4">
      <BackLink />

      {/* Header */}
      <Card>
        <CardContent className="space-y-2 pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-sm font-semibold" title={data.path}>
              {data.name}
            </h1>
            <Badge variant="outline">{data.layer}</Badge>
            <Badge variant="outline">{data.lifecycle}</Badge>
            {data.version && <span className="text-xs text-muted-foreground">v{data.version}</span>}
          </div>
          {data.description && <p className="text-xs text-muted-foreground">{data.description}</p>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span title={data.path}>path: {data.path}</span>
            <span>source: {data.source}</span>
          </div>
        </CardContent>
      </Card>

      {/* Inputs */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-base">Inputs</CardTitle>
        </CardHeader>
        <CardContent>
          {data.inputs.length === 0 ? (
            <p className="text-xs text-muted-foreground">This workflow takes no inputs.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Name</th>
                    <th className="py-1 pr-3 font-medium">Type</th>
                    <th className="py-1 pr-3 font-medium">Required</th>
                    <th className="py-1 pr-3 font-medium">Default</th>
                    <th className="py-1 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {data.inputs.map((input) => (
                    <tr key={input.name} className="border-b border-border/50 last:border-0">
                      <td className="py-1 pr-3 font-mono">{input.name}</td>
                      <td className="py-1 pr-3 text-muted-foreground">{input.type}</td>
                      <td className="py-1 pr-3">{input.required ? "yes" : "no"}</td>
                      <td className="py-1 pr-3 font-mono text-muted-foreground">
                        {input.default === null || input.default === undefined ? "—" : String(input.default)}
                      </td>
                      <td className="py-1 text-muted-foreground">{input.description ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Steps */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-base">Steps</CardTitle>
        </CardHeader>
        <CardContent>
          {data.steps.length === 0 ? (
            <p className="text-xs text-muted-foreground">This workflow has no steps.</p>
          ) : (
            <ol className="space-y-1.5">
              {data.steps.map((step, i) => (
                <li key={`${step.name}-${i}`} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">{i + 1}.</span>
                  <span className="font-medium">{step.name}</span>
                  <Badge variant="outline">{step.node_type}</Badge>
                  {(step.server_type || step.tool_name) && (
                    <span className="font-mono text-muted-foreground">
                      {step.server_type ?? "?"}.{step.tool_name ?? "?"}
                    </span>
                  )}
                  {step.condition && (
                    <span className="text-muted-foreground">
                      if <span className="font-mono">{step.condition}</span>
                    </span>
                  )}
                  {step.continue_on_error && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    >
                      continue on error
                    </Badge>
                  )}
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* Definition YAML */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <CardTitle className="text-base">Definition</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-(--sz-240px) overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            {data.definition_yaml}
          </pre>
        </CardContent>
      </Card>

      {/* Footprint */}
      <Card>
        <CardHeader className="flex-row items-center gap-2 space-y-0">
          <Boxes className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">
            Footprint — manages {footprint.count} known resource{footprint.count === 1 ? "" : "s"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">{footprint.note}</p>
          {footprint.resources.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No resources are attributed to this workflow yet.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {footprint.resources.map((r) => (
                <li key={r.resourceUri} className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate font-mono" title={r.resourceUri}>
                    {r.resourceUri}
                  </span>
                  <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    <span>{r.assetType}</span>
                    <span>{r.projectId}</span>
                    <Badge variant="outline">{r.source}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function WorkflowDetail() {
  const { name } = useParams<{ name: string }>();

  const detail = useQuery({
    queryKey: ["apex", "workflows", name],
    queryFn: () => workflowsApi.show(name as string),
    enabled: !!name,
  });

  if (!name) {
    return <div className="p-6 text-sm text-muted-foreground">No workflow selected.</div>;
  }

  return <WorkflowDetailBody isLoading={detail.isLoading} data={detail.data} />;
}
