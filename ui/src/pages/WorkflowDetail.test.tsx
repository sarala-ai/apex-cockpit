// @vitest-environment node

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkflowDetailResponse } from "@paperclipai/shared";
import { WorkflowDetailBody } from "./WorkflowDetail";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useParams: () => ({ name: "deploy-cloudrun" }),
}));

const DETAIL: Extract<WorkflowDetailResponse, { status: "success" }> = {
  status: "success",
  name: "deploy-cloudrun",
  version: "1.2.0",
  lifecycle: "stable",
  description: "Deploys a service to Cloud Run.",
  path: "/builtin/deploy-cloudrun.yaml",
  source: "apex-core",
  layer: "built-in",
  inputs: [{ name: "project_id", type: "string", required: true, default: null, description: "GCP project" }],
  steps: [
    { name: "build", node_type: "tool_call", server_type: "gcp", tool_name: "build_image", condition: null, continue_on_error: false },
    { name: "deploy", node_type: "tool_call", server_type: "gcp", tool_name: "deploy_service", condition: "steps.build.success", continue_on_error: true },
  ],
  outputs: [{ name: "service_url" }],
  definition_yaml: "name: deploy-cloudrun\nsteps:\n  - name: build\n",
  footprint: { resources: [], count: 0, note: "db-known attribution only — resources this cockpit has recorded as belonging to this workflow, not a live cloud query." },
};

function render(props: Partial<Parameters<typeof WorkflowDetailBody>[0]>) {
  return renderToStaticMarkup(<WorkflowDetailBody isLoading={false} data={undefined} {...props} />);
}

describe("WorkflowDetailBody", () => {
  it("shows a loading state", () => {
    const html = render({ isLoading: true });
    expect(html).toContain("Loading workflow");
  });

  it("renders the degraded-CLI classified error, styled like other error states", () => {
    const html = render({
      data: {
        status: "error",
        error_type: "cli_missing_command",
        message: "requires apex-platform with the workflows CLI (unreleased)",
        remediation: "Install apex-platform.",
      },
    });
    expect(html).toContain("requires apex-platform with the workflows CLI (unreleased)");
    expect(html).toContain("cli_missing_command");
    expect(html).toContain("Install apex-platform.");
  });

  it("renders the CLI's own not_found error the same way", () => {
    const html = render({
      data: { status: "error", error_type: "not_found", message: "No workflow named 'ghost'.", remediation: null },
    });
    expect(html).toContain("No workflow named");
    expect(html).toContain("ghost");
    expect(html).toContain("not_found");
  });

  it("renders inputs table, ordered steps with server.tool + condition, and the raw YAML block", () => {
    const html = render({ data: DETAIL });
    expect(html).toContain("deploy-cloudrun");
    expect(html).toContain("project_id");
    expect(html).toContain("gcp.build_image");
    expect(html).toContain("gcp.deploy_service");
    expect(html).toContain("steps.build.success");
    expect(html).toContain("continue on error");
    expect(html).toContain("name: deploy-cloudrun");
  });

  it("renders an honest empty footprint state", () => {
    const html = render({ data: DETAIL });
    expect(html).toContain("manages 0 known resources");
    expect(html).toContain("No resources are attributed to this workflow yet.");
    expect(html).toContain("db-known attribution only");
  });

  it("lists footprint resources by assetType/project when present", () => {
    const withResources: typeof DETAIL = {
      ...DETAIL,
      footprint: {
        resources: [{ resourceUri: "//run.googleapis.com/projects/p/services/svc-a", assetType: "run.googleapis.com/Service", projectId: "finpilot-dev", source: "manual" }],
        count: 1,
        note: DETAIL.footprint.note,
      },
    };
    const html = render({ data: withResources });
    expect(html).toContain("manages 1 known resource");
    expect(html).toContain("run.googleapis.com/Service");
    expect(html).toContain("finpilot-dev");
  });
});
