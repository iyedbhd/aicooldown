"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

type Theme = "light" | "dark";

function current(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Flips between light and dark. The choice is remembered per browser; the first visit follows the OS. */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const frame = requestAnimationFrame(() => setTheme(current()));
    return () => cancelAnimationFrame(frame);
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("aic:theme", next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      className={className}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Light mode" : "Dark mode"}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} />
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}
