// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./InlineEditor", () => ({
  InlineEditor: ({ value }: { value: string }) => (
    <div data-testid="agent-brief-editor">{value}</div>
  ),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { AgentBriefSection } from "./AgentBriefSection";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BRIEF = 'apex run penpot update-file {"type":"add-obj","x":5190,"y":952}';

let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let root: any;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode) {
  act(() => root.render(node));
}

describe("AgentBriefSection", () => {
  it("renders nothing when a ticket has no brief — existing tickets gain no chrome", () => {
    render(<AgentBriefSection value={null} onSave={() => {}} />);
    expect(container.querySelector('[data-testid="agent-brief-section"]')).toBeNull();
    expect(container.textContent).toBe("");

    render(<AgentBriefSection value="   " onSave={() => {}} />);
    expect(container.querySelector('[data-testid="agent-brief-section"]')).toBeNull();
  });

  it("is collapsed by default: the label shows, the machine detail does not", () => {
    render(<AgentBriefSection value={BRIEF} onSave={() => {}} />);

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-brief-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain("Agent brief");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");

    expect(container.querySelector('[data-testid="agent-brief-editor"]')).toBeNull();
    expect(container.textContent).not.toContain("add-obj");

    const details = container.querySelector<HTMLDivElement>("#agent-brief-details");
    expect(details?.hasAttribute("hidden")).toBe(true);
    expect(toggle?.getAttribute("aria-controls")).toBe("agent-brief-details");
  });

  it("expands to the full brief on click, and collapses again", () => {
    render(<AgentBriefSection value={BRIEF} onSave={() => {}} />);
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="agent-brief-toggle"]')!;

    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="agent-brief-editor"]')?.textContent).toBe(BRIEF);
    expect(container.querySelector<HTMLDivElement>("#agent-brief-details")?.hasAttribute("hidden")).toBe(
      false,
    );

    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="agent-brief-editor"]')).toBeNull();
  });
});
