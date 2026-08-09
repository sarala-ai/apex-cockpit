import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type Theme = "light" | "dark";
type ThemePreference = "light" | "dark" | "system";

interface ThemeContextValue {
  /** The resolved theme currently applied to the document. */
  theme: Theme;
  /** The user's stored preference; `system` follows the OS live. */
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** Cycle light → dark → system → light. */
  cycleTheme: () => void;
}

const THEME_STORAGE_KEY = "paperclip.theme";
const DARK_THEME_COLOR = "#18181b";
const LIGHT_THEME_COLOR = "#ffffff";
// Product decision (APEX-75): an unset preference resolves to dark. The OS
// `prefers-color-scheme` is honoured only when the user explicitly picks
// "system". The pre-paint script in ui/index.html applies the same rules.
const DEFAULT_PREFERENCE: ThemePreference = "dark";
const CYCLE_ORDER: Record<ThemePreference, ThemePreference> = {
  light: "dark",
  dark: "system",
  system: "light",
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function readStoredPreference(): ThemePreference | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : null;
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(preference: ThemePreference, prefersDark: boolean): Theme {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark";
  const root = document.documentElement;
  root.classList.toggle("dark", isDark);
  root.style.colorScheme = isDark ? "dark" : "light";
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta instanceof HTMLMetaElement) {
    themeColorMeta.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => readStoredPreference() ?? DEFAULT_PREFERENCE,
  );
  // Track whether the preference came from an explicit user action (now or a
  // previous session). The built-in default is applied but never persisted.
  const [hasExplicitChoice, setHasExplicitChoice] = useState<boolean>(
    () => readStoredPreference() !== null,
  );
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  const theme = resolveTheme(preference, prefersDark);

  const setPreference = useCallback((next: ThemePreference) => {
    setHasExplicitChoice(true);
    setPreferenceState(next);
  }, []);

  const cycleTheme = useCallback(() => {
    setHasExplicitChoice(true);
    setPreferenceState((current) => CYCLE_ORDER[current]);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!hasExplicitChoice) return;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Ignore local storage write failures in restricted environments.
    }
  }, [preference, hasExplicitChoice]);

  // While the preference is "system", follow OS-level changes live.
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    setPrefersDark(media.matches);
    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [preference]);

  const value = useMemo(
    () => ({
      theme,
      preference,
      setPreference,
      cycleTheme,
    }),
    [theme, preference, setPreference, cycleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
