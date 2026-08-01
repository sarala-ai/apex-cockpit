// @vitest-environment node

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CapabilitySyncStatusResponse, WorkflowListResponse } from "@paperclipai/shared";
import { CapabilitySyncBanner, WorkflowsBody } from "./Workflows";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const SUCCESS: WorkflowListResponse = {
  status: "success",
  workflows: [
    { name: "deploy-cloudrun", path: "/builtin/deploy-cloudrun.yaml", source: "apex-core", layer: "built-in", lifecycle: "stable", shadowed_count: 1, shadows_other_layer: false },
    { name: "rotate-secrets", path: "~/.apex/workflows/rotate-secrets.yaml", source: "user", layer: "user", lifecycle: "beta", shadowed_count: 0, shadows_other_layer: true },
    { name: "custom-migration", path: ".apex/workflows/custom-migration.yaml", source: "repo", layer: "project", lifecycle: "experimental", shadowed_count: 0, shadows_other_layer: false },
  ],
};

function render(props: Partial<Parameters<typeof WorkflowsBody>[0]>) {
  return renderToStaticMarkup(<WorkflowsBody isLoading={false} data={undefined} {...props} />);
}

describe("WorkflowsBody", () => {
  it("shows a loading state", () => {
    const html = render({ isLoading: true });
    expect(html).toContain("Loading workflows");
  });

  it("renders the degraded-CLI classified error, styled like other error states", () => {
    const html = render({
      data: {
        status: "error",
        error_type: "cli_missing_command",
        message: "requires apex-platform with the workflows CLI (unreleased)",
        remediation: "Install the apex-platform build that ships the workflows CLI.",
      },
    });
    expect(html).toContain("requires apex-platform with the workflows CLI (unreleased)");
    expect(html).toContain("cli_missing_command");
    expect(html).toContain("Install the apex-platform build that ships the workflows CLI.");
  });

  it("groups the catalog by layer (built-in / user / project) with shadowed badges", () => {
    const html = render({ data: SUCCESS });
    expect(html).toContain("Built-in");
    expect(html).toContain("User");
    expect(html).toContain("Project");
    expect(html).toContain("deploy-cloudrun");
    expect(html).toContain("rotate-secrets");
    expect(html).toContain("custom-migration");
    // shadowed_count > 0 → "shadows N" badge; shadows_other_layer → "shadowed" badge.
    expect(html).toContain("shadows 1");
    expect(html).toContain("shadowed");
  });

  it("renders an honest empty layer bucket when a layer has no workflows", () => {
    const builtInOnly: WorkflowListResponse = {
      status: "success",
      workflows: [{ name: "deploy-cloudrun", path: "/builtin/deploy-cloudrun.yaml", source: "apex-core", layer: "built-in", lifecycle: "stable", shadowed_count: 0, shadows_other_layer: false }],
    };
    const html = render({ data: builtInOnly });
    expect(html).toContain("No user workflows");
    expect(html).toContain("No project workflows");
  });
});

function renderBanner(props: Partial<Parameters<typeof CapabilitySyncBanner>[0]>) {
  return renderToStaticMarkup(<CapabilitySyncBanner status={undefined} {...props} />);
}

const DIVERGED_STATUS: CapabilitySyncStatusResponse = {
  ranAt: "2026-08-01T00:00:00.000Z",
  summary: {
    status: "success",
    synced_at: "2026-08-01T00:00:00.000Z",
    sources: ["acme"],
    items: [{ alias: "acme", kind: "workflows", path: "~/.apex/company/acme/workflows/deploy.yaml", status: "diverged", digest: "abc" }],
    diverged: [{ alias: "acme", kind: "workflows", path: "~/.apex/company/acme/workflows/deploy.yaml", status: "diverged", digest: "abc" }],
    pending_skills: [{ alias: "acme", path: "~/.apex/company/acme/skills/lint", digest: "def", reason: "skills_auto not enabled" }],
  },
};

const CLEAN_STATUS: CapabilitySyncStatusResponse = {
  ranAt: "2026-08-01T00:00:00.000Z",
  summary: {
    status: "success",
    synced_at: "2026-08-01T00:00:00.000Z",
    sources: ["acme"],
    items: [{ alias: "acme", kind: "workflows", path: "~/.apex/company/acme/workflows/deploy.yaml", status: "synced", digest: "abc" }],
    diverged: [],
    pending_skills: [],
  },
};

const CLI_MISSING_STATUS: CapabilitySyncStatusResponse = {
  ranAt: "2026-08-01T00:00:00.000Z",
  summary: {
    status: "error",
    error_type: "cli_missing_command",
    message: "requires apex-core with the capabilities CLI (unreleased)",
    remediation: null,
  },
};

const REAL_ERROR_STATUS: CapabilitySyncStatusResponse = {
  ranAt: "2026-08-01T00:00:00.000Z",
  summary: { status: "error", error_type: "clone_failed", message: "could not clone acme/store", remediation: null },
};

describe("CapabilitySyncBanner", () => {
  it("renders nothing before the first sync since boot (no run yet, honest empty state)", () => {
    expect(renderBanner({ status: undefined })).toBe("");
    expect(renderBanner({ status: { ranAt: null, summary: null } })).toBe("");
  });

  it("renders nothing when the CLI doesn't have the command yet — no error spam", () => {
    expect(renderBanner({ status: CLI_MISSING_STATUS })).toBe("");
  });

  it("renders nothing for a clean sync with nothing diverged or pending", () => {
    expect(renderBanner({ status: CLEAN_STATUS })).toBe("");
  });

  it("renders a warning strip with diverged + pending-skills counts", () => {
    const html = renderBanner({ status: DIVERGED_STATUS });
    expect(html).toContain("1 diverged item");
    expect(html).toContain("1 skill update");
    expect(html).toContain("--accept-skills");
  });

  it("renders a genuine sync failure distinctly from the quiet cli_missing_command case", () => {
    const html = renderBanner({ status: REAL_ERROR_STATUS });
    expect(html).toContain("Capability sync failed");
    expect(html).toContain("could not clone acme/store");
  });

  it("includes a refresh control when onRefresh is supplied", () => {
    const html = renderBanner({ status: DIVERGED_STATUS, onRefresh: () => {} });
    expect(html).toContain("Refresh");
  });
});
