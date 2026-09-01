// @vitest-environment node

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunDetail as RunDetailRecord } from "@paperclipai/shared";
import { RunDetailBody } from "./RunDetail";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useParams: () => ({ runId: "run-1" }),
}));

const BASE_RUN: RunDetailRecord["run"] = {
  runId: "run-1",
  status: "succeeded",
  startedAt: "2026-07-27T10:00:00Z",
  finishedAt: "2026-07-27T10:05:00Z",
  durationMs: 300_000,
  stopReason: "end_turn",
  agentName: "orchestrator-dev",
  issueId: "issue-abc12345",
  usage: { inputTokens: 5000, outputTokens: 1200, cachedInputTokens: null, costUsd: 0.42, model: "claude-sonnet-5" },
};

function render(props: Partial<Parameters<typeof RunDetailBody>[0]>) {
  return renderToStaticMarkup(
    <RunDetailBody isLoading={false} isError={false} data={undefined} {...props} />,
  );
}

describe("RunDetailBody", () => {
  it("shows a loading state", () => {
    const html = render({ isLoading: true });
    expect(html).toContain("Loading run");
  });

  it("shows an honest not-found state on error", () => {
    const html = render({ isError: true });
    expect(html).toContain("Run not found");
  });

  it("shows an honest not-found state when data is missing (no store owns the run)", () => {
    const html = render({ data: undefined });
    expect(html).toContain("Run not found");
  });

  it("renders the header with agent, ticket, status, and cost", () => {
    const html = render({ data: { run: BASE_RUN, spans: [], toolCalls: [], evals: [] } });
    expect(html).toContain("run-1");
    expect(html).toContain("orchestrator-dev");
    expect(html).toContain("succeeded");
    expect(html).toContain("issue-a");
    expect(html).toContain("0.4200");
  });

  it("shows an honest empty state when there is no trace", () => {
    const html = render({ data: { run: BASE_RUN, spans: [], toolCalls: [], evals: [] } });
    expect(html).toContain("No trace recorded for this run.");
  });

  it("shows an honest empty state when there are no evals", () => {
    const html = render({ data: { run: BASE_RUN, spans: [], toolCalls: [], evals: [] } });
    expect(html).toContain("No evals recorded for this run.");
  });

  it("shows an amber bypass chip when the run carries no permission stamp (interactive default)", () => {
    const html = render({ data: { run: BASE_RUN, spans: [], toolCalls: [], evals: [] } });
    expect(html).toContain("bypass");
  });

  it("shows a governed · <profile> chip for a flow-commissioned run", () => {
    const html = render({
      data: {
        run: { ...BASE_RUN, permissionMode: "governed", permissionProfile: "bounded" },
        spans: [],
        toolCalls: [],
        evals: [],
      },
    });
    expect(html).toContain("governed");
    expect(html).toContain("bounded");
    expect(html).not.toContain(">bypass<");
  });

  it("renders the span tree nested by parentSpanId, with an error span flagged", () => {
    const html = render({
      data: {
        run: BASE_RUN,
        spans: [
          { kind: "agent.run", name: "root-span", startedAt: null, durationMs: 5000, attributes: {}, spanId: "root", parentSpanId: null },
          {
            kind: "tool.call",
            name: "failing-tool",
            startedAt: null,
            durationMs: 120,
            attributes: { "apex.tool.success": false },
            spanId: "child",
            parentSpanId: "root",
          },
        ],
        toolCalls: [],
        evals: [],
      },
    });
    expect(html).toContain("root-span");
    expect(html).toContain("failing-tool");
    expect(html).toContain("error");
  });

  it("renders eval verdicts with score and reason", () => {
    const html = render({
      data: {
        run: BASE_RUN,
        spans: [],
        toolCalls: [],
        evals: [
          {
            runId: "run-1",
            scenario: "happy-path",
            validator: "trajectory-check",
            verdict: "fail",
            score: 0.2,
            reason: "missing tool call",
            occurredAt: null,
          },
        ],
      },
    });
    expect(html).toContain("trajectory-check");
    expect(html).toContain("happy-path");
    expect(html).toContain("missing tool call");
  });
});
