import { useSyncExternalStore } from "react";
import { desktopApp } from "./desktop";
import { THEME_KEY } from "./theme-init";

/** "system" follows Windows (or macOS, or the browser) as it changes. */
export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const listeners = new Set<() => void>();

export function themePref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

const systemTheme = (): Theme => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");

/** Puts the choice on the page, and on the desktop app's title bar buttons and menus. */
export function applyTheme(pref: ThemePref = themePref()): void {
  const theme = pref === "system" ? systemTheme() : pref;
  document.documentElement.dataset.theme = theme;
  desktopApp()?.setTheme(theme, pref !== "system");
  for (const listener of listeners) listener();
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* remembering it is a nicety */
  }
  applyTheme(pref);
}

/** Follows the system while the choice is "system", and choices made in other tabs. Returns a stop function. */
export function watchTheme(): () => void {
  const media = matchMedia("(prefers-color-scheme: light)");
  const onSystem = () => themePref() === "system" && applyTheme("system");
  const onStorage = (e: StorageEvent) => (e.key === THEME_KEY || e.key === null) && applyTheme();
  media.addEventListener("change", onSystem);
  window.addEventListener("storage", onStorage);
  applyTheme();
  return () => {
    media.removeEventListener("change", onSystem);
    window.removeEventListener("storage", onStorage);
  };
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, themePref, () => "system");
}

/** The theme showing now. */
export function useTheme(): Theme {
  return useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    () => "dark",
  );
}
