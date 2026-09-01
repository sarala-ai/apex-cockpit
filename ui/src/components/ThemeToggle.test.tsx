// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "./ThemeToggle";

const mockCycleTheme = vi.hoisted(() => vi.fn());
const mockPreference = vi.hoisted(() => ({ value: "dark" as "dark" | "light" | "system" }));

vi.mock("../context/ThemeContext", () => ({
  useTheme: () => ({
    theme: mockPreference.value === "light" ? "light" : "dark",
    preference: mockPreference.value,
    cycleTheme: mockCycleTheme,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("ThemeToggle", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockPreference.value = "dark";
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders an icon button by default labelled with the next step in the cycle (dark → system)", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();

    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Switch to system theme");
    expect(button?.getAttribute("title")).toBe("Switch to system theme");

    await act(async () => {
      button?.click();
    });
    expect(mockCycleTheme).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("renders a menu-action row when variant='menu-action' showing the current mode", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle variant="menu-action" />);
    });
    await flushReact();

    expect(container.textContent).toContain("Switch to system theme");
    expect(container.textContent).toContain("Theme is dark.");

    await act(async () => root.unmount());
  });

  it("calls onAfterToggle after cycling (used by SidebarAccountMenu to close the popover)", async () => {
    const onAfterToggle = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle variant="menu-action" onAfterToggle={onAfterToggle} />);
    });
    await flushReact();

    const button = container.querySelector("button");
    await act(async () => {
      button?.click();
    });

    expect(mockCycleTheme).toHaveBeenCalledTimes(1);
    expect(onAfterToggle).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("labels each preference with its next step in the cycle", async () => {
    mockPreference.value = "light";
    const root = createRoot(container);
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();

    let button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Switch to dark theme");

    mockPreference.value = "system";
    await act(async () => {
      root.render(<ThemeToggle />);
    });
    await flushReact();

    button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Switch to light theme");

    await act(async () => root.unmount());
  });
});
