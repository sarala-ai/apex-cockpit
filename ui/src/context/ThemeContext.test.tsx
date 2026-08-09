// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeContext";

const mockUiPreferencesApi = vi.hoisted(() => ({
  get: vi.fn(async (): Promise<{ theme: "light" | "dark" | "system" | null; updatedAt: null }> => ({
    theme: null,
    updatedAt: null,
  })),
  update: vi.fn(async (data: { theme: "light" | "dark" | "system" }) => ({
    theme: data.theme,
    updatedAt: null,
  })),
}));

vi.mock("../api/uiPreferences", () => ({ uiPreferencesApi: mockUiPreferencesApi }));

const THEME_STORAGE_KEY = "paperclip.theme";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MediaListener = (event: MediaQueryListEvent) => void;

interface FakeMediaQueryList {
  matches: boolean;
  addEventListener: (type: "change", listener: MediaListener) => void;
  removeEventListener: (type: "change", listener: MediaListener) => void;
  dispatch: (matches: boolean) => void;
  listenerCount: () => number;
}

function installMatchMedia(initialMatches: boolean): FakeMediaQueryList {
  const listeners = new Set<MediaListener>();
  const mql: FakeMediaQueryList = {
    matches: initialMatches,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
    dispatch: (matches) => {
      mql.matches = matches;
      const event = { matches } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
    listenerCount: () => listeners.size,
  };
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      if (query !== "(prefers-color-scheme: dark)") {
        throw new Error(`unexpected media query: ${query}`);
      }
      return mql as unknown as MediaQueryList;
    },
  });
  return mql;
}

describe("ThemeContext", () => {
  let container: HTMLDivElement;
  let observedTheme: "light" | "dark" | null = null;
  let observedPreference: "light" | "dark" | "system" | null = null;
  let setPreference: ((preference: "light" | "dark" | "system") => void) | null = null;
  let cycleTheme: (() => void) | null = null;

  function Probe() {
    const ctx = useTheme();
    observedTheme = ctx.theme;
    observedPreference = ctx.preference;
    setPreference = ctx.setPreference;
    cycleTheme = ctx.cycleTheme;
    return null;
  }

  function mount() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <Probe />
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    return root;
  }

  async function flushQueries() {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockUiPreferencesApi.get.mockResolvedValue({ theme: null, updatedAt: null });
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    observedTheme = null;
    observedPreference = null;
    setPreference = null;
    cycleTheme = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("defaults to dark when nothing is stored, even if the OS prefers light", () => {
    const mql = installMatchMedia(false);
    const root = mount();

    expect(observedPreference).toBe("dark");
    expect(observedTheme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // The built-in default is not persisted and does not follow the OS.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(mql.listenerCount()).toBe(0);

    act(() => {
      root.unmount();
    });
  });

  it("follows OS prefers-color-scheme live while preference is system", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "system");
    const mql = installMatchMedia(true);
    const root = mount();

    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("dark");
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      mql.dispatch(false);
    });
    expect(observedTheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("dark");
    // The stored preference stays "system" while the resolved theme flips.
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");

    act(() => {
      root.unmount();
    });
  });

  it("applies and persists an explicit light/dark preference, ignoring OS changes", () => {
    const mql = installMatchMedia(true);
    const root = mount();

    act(() => {
      setPreference?.("light");
    });
    expect(observedPreference).toBe("light");
    expect(observedTheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(mql.listenerCount()).toBe(0);

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("light");

    act(() => {
      root.unmount();
    });
  });

  it("cycles light → dark → system → light and persists each step", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const mql = installMatchMedia(false);
    const root = mount();

    expect(observedPreference).toBe("light");

    act(() => {
      cycleTheme?.();
    });
    expect(observedPreference).toBe("dark");
    expect(observedTheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    act(() => {
      cycleTheme?.();
    });
    expect(observedPreference).toBe("system");
    expect(observedTheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
    expect(mql.listenerCount()).toBe(1);

    act(() => {
      cycleTheme?.();
    });
    expect(observedPreference).toBe("light");
    expect(observedTheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(mql.listenerCount()).toBe(0);

    act(() => {
      root.unmount();
    });
  });

  it("adopts the server-side preference on load and mirrors it into localStorage", async () => {
    mockUiPreferencesApi.get.mockResolvedValue({ theme: "light", updatedAt: null });
    installMatchMedia(true);
    const root = mount();

    expect(observedPreference).toBe("dark");
    await flushQueries();

    expect(observedPreference).toBe("light");
    expect(observedTheme).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

    act(() => {
      root.unmount();
    });
  });

  it("writes explicit changes to the server and does not let a late fetch clobber them", async () => {
    let resolveGet: (value: { theme: "dark" | null; updatedAt: null }) => void = () => {};
    mockUiPreferencesApi.get.mockReturnValue(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    installMatchMedia(true);
    const root = mount();

    act(() => {
      setPreference?.("light");
    });
    expect(mockUiPreferencesApi.update).toHaveBeenCalledWith({ theme: "light" });

    resolveGet({ theme: "dark", updatedAt: null });
    await flushQueries();
    expect(observedPreference).toBe("light");

    act(() => {
      root.unmount();
    });
  });

  it("restores a stored explicit preference without attaching the OS listener", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    const mql = installMatchMedia(true);
    const root = mount();

    expect(observedPreference).toBe("light");
    expect(observedTheme).toBe("light");
    expect(mql.listenerCount()).toBe(0);

    act(() => {
      mql.dispatch(true);
    });
    expect(observedTheme).toBe("light");

    act(() => {
      root.unmount();
    });
  });
});
