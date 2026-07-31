import { describe, expect, it } from "vitest";
import { buildSpanTree, isErrorSpan, type TraceSpan } from "./observe.js";

function span(partial: Partial<TraceSpan> & { spanId: string }): TraceSpan {
  return {
    kind: "tool.call",
    name: "test-span",
    startedAt: null,
    durationMs: null,
    attributes: {},
    traceId: "trace-1",
    parentSpanId: null,
    ...partial,
  };
}

describe("buildSpanTree", () => {
  it("nests children under their parent by parentSpanId → spanId", () => {
    const spans: TraceSpan[] = [
      span({ spanId: "root", name: "agent.run" }),
      span({ spanId: "child-1", parentSpanId: "root", name: "llm.call" }),
      span({ spanId: "grandchild", parentSpanId: "child-1", name: "tool.call" }),
      span({ spanId: "child-2", parentSpanId: "root", name: "tool.call" }),
    ];

    const tree = buildSpanTree(spans);

    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe("root");
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children.map((c) => c.spanId)).toEqual(["child-1", "child-2"]);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children).toHaveLength(1);
    expect(tree[0].children[0].children[0].spanId).toBe("grandchild");
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("surfaces a span with no parentSpanId as a root", () => {
    const spans: TraceSpan[] = [span({ spanId: "solo" })];
    const tree = buildSpanTree(spans);
    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe("solo");
  });

  it("treats an orphan (parentSpanId pointing outside the list) as a root — lossless, never dropped", () => {
    const spans: TraceSpan[] = [
      span({ spanId: "a", parentSpanId: "does-not-exist" }),
      span({ spanId: "b", parentSpanId: "a" }),
    ];
    const tree = buildSpanTree(spans);
    // "a" is an orphan root (its parent isn't in this span list), "b" nests under it.
    expect(tree).toHaveLength(1);
    expect(tree[0].spanId).toBe("a");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].spanId).toBe("b");
  });

  it("treats a span with no spanId at all as its own root (can't be parented or have children)", () => {
    const spans: TraceSpan[] = [
      { ...span({ spanId: "root" }), spanId: undefined as unknown as string },
    ];
    const tree = buildSpanTree(spans);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toEqual([]);
  });

  it("every input span appears exactly once in the output (lossless flat → tree)", () => {
    const spans: TraceSpan[] = [
      span({ spanId: "root" }),
      span({ spanId: "orphan-1", parentSpanId: "missing-1" }),
      span({ spanId: "orphan-2", parentSpanId: "missing-2" }),
      span({ spanId: "child", parentSpanId: "root" }),
    ];
    const tree = buildSpanTree(spans);

    function countAll(nodes: ReturnType<typeof buildSpanTree>): number {
      return nodes.reduce((sum, n) => sum + 1 + countAll(n.children), 0);
    }
    expect(countAll(tree)).toBe(spans.length);
  });

  it("returns an empty tree for an empty span list", () => {
    expect(buildSpanTree([])).toEqual([]);
  });
});

describe("isErrorSpan", () => {
  it("flags a span with attributes.status_code ERROR", () => {
    expect(isErrorSpan(span({ spanId: "s", attributes: { status_code: "ERROR" } }))).toBe(true);
    expect(isErrorSpan(span({ spanId: "s", attributes: { status_code: "error" } }))).toBe(true);
  });

  it("flags a failed tool.call (apex.tool.success === false)", () => {
    expect(isErrorSpan(span({ spanId: "s", attributes: { "apex.tool.success": false } }))).toBe(true);
  });

  it("does not flag a normal span", () => {
    expect(isErrorSpan(span({ spanId: "s", attributes: { "apex.tool.success": true } }))).toBe(false);
    expect(isErrorSpan(span({ spanId: "s", attributes: {} }))).toBe(false);
  });
});
