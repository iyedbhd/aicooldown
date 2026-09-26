"use client";

import { setThemePref, useTheme } from "@/lib/theme";
import { Icon } from "./Icon";

/** Flips between light and dark. The choice is remembered per browser; Settings can go back to following the system. */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setThemePref(next)}
      className={className}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
