import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "../context/ThemeContext";

type ThemeToggleVariant = "icon" | "menu-action";

interface ThemeToggleProps {
  className?: string;
  /**
   * `icon` (default): compact icon button — suitable for headers,
   * floating chrome (e.g. the unauthenticated `/auth` page), and any
   * other surface that just wants a toggle affordance.
   *
   * `menu-action`: full-width row with label + description + icon —
   * matches the surrounding `MenuAction` rows in `SidebarAccountMenu`.
   */
  variant?: ThemeToggleVariant;
  /**
   * Called after `cycleTheme` runs. Surfaces like a popover menu use
   * this to dismiss the menu once the user has acted.
   */
  onAfterToggle?: () => void;
}

const PREFERENCE_META = {
  light: { icon: Sun, name: "light", next: "dark" },
  dark: { icon: Moon, name: "dark", next: "system" },
  system: { icon: Monitor, name: "system", next: "light" },
} as const;

/**
 * Canonical theme-toggle widget. Both the signed-out `/auth` chrome and
 * the in-app account menu render through this component so the label,
 * icon, and cycle behaviour stay in sync as the theme model evolves.
 * Cycles light → dark → system.
 */
export function ThemeToggle({ className, variant = "icon", onAfterToggle }: ThemeToggleProps) {
  const { preference, cycleTheme } = useTheme();
  const meta = PREFERENCE_META[preference];
  const Icon = meta.icon;
  const label = `Switch to ${meta.next} theme`;
  const description =
    preference === "system"
      ? "Theme is following your OS."
      : `Theme is ${meta.name}. System follows your OS.`;

  function handleClick() {
    cycleTheme();
    onAfterToggle?.();
  }

  if (variant === "menu-action") {
    return (
      <button
        type="button"
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60",
          className,
        )}
        onClick={handleClick}
        aria-label={label}
      >
        <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="block text-xs text-muted-foreground">{description}</span>
        </span>
      </button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground", className)}
    >
      <Icon />
    </Button>
  );
}
