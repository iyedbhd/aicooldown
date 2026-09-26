import { useSyncExternalStore } from "react";
import { desktopApp } from "./desktop";
import { formatCountdown } from "./format";
import type { Account, Usage } from "./types";

const KEY = "ai-usage-tracker:notify";
const PREFS_KEY = "aic:notify-prefs";

/** In a browser, once asked for and allowed; in the desktop app, which needs no permission, unless turned off. */
export function notifyEnabled(): boolean {
  try {
    const choice = localStorage.getItem(KEY);
    if (desktopApp()) return choice !== "0";
    return choice === "1" && typeof Notification !== "undefined" && Notification.permission === "granted";
  } catch {
    return false;
  }
}

export function setNotifyEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export type PermissionResult = "granted" | "denied" | "unsupported";

export async function requestNotifyPermission(): Promise<PermissionResult> {
  if (desktopApp()) return "granted";
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  const result = await Notification.requestPermission();
  return result === "granted" ? "granted" : "denied";
}

// ---- What to be told about, and when not.

export type NotifyPrefs = {
  /** A window that was at least 40% used drops back by 30 points or more. */
  reset: boolean;
  /** Crossing this share used, in percent; null for never. */
  threshold: number | null;
  /** A window reaching 100%. */
  exhausted: boolean;
  /** Local "HH:MM" times: nothing about limits is sent from `from` until `to`. */
  quiet: { from: string; to: string } | null;
  /** Accounts nothing is sent about. */
  muted: string[];
};

/** Today's behaviour before there were preferences. */
export const DEFAULT_PREFS: NotifyPrefs = { reset: true, threshold: 90, exhausted: true, quiet: null, muted: [] };
export const THRESHOLDS = [50, 75, 80, 85, 90, 95];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
let prefsCache: NotifyPrefs | null = null;
const prefsListeners = new Set<() => void>();

function readPrefs(): NotifyPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return DEFAULT_PREFS;
    const p = raw as Partial<Record<keyof NotifyPrefs, unknown>>;
    const quiet = p.quiet as NotifyPrefs["quiet"] | undefined;
    return {
      reset: typeof p.reset === "boolean" ? p.reset : DEFAULT_PREFS.reset,
      threshold: p.threshold === null || (typeof p.threshold === "number" && p.threshold > 0 && p.threshold < 100) ? (p.threshold as number | null) : DEFAULT_PREFS.threshold,
      exhausted: typeof p.exhausted === "boolean" ? p.exhausted : DEFAULT_PREFS.exhausted,
      quiet: quiet && TIME.test(quiet.from) && TIME.test(quiet.to) ? { from: quiet.from, to: quiet.to } : null,
      muted: Array.isArray(p.muted) ? p.muted.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function notifyPrefs(): NotifyPrefs {
  prefsCache ??= readPrefs();
  return prefsCache;
}

export function setNotifyPrefs(patch: Partial<NotifyPrefs>): void {
  prefsCache = { ...notifyPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefsCache));
  } catch {
    /* kept for this session */
  }
  for (const listener of prefsListeners) listener();
}

export function setMuted(accountId: string, muted: boolean): void {
  const rest = notifyPrefs().muted.filter((id) => id !== accountId);
  setNotifyPrefs({ muted: muted ? [...rest, accountId] : rest });
}

function subscribePrefs(listener: () => void) {
  prefsListeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== PREFS_KEY && e.key !== null) return;
    prefsCache = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    prefsListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useNotifyPrefs(): NotifyPrefs {
  return useSyncExternalStore(subscribePrefs, notifyPrefs, () => DEFAULT_PREFS);
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Whether `at` falls in the quiet hours, which may run past midnight. */
export function inQuietHours(prefs: NotifyPrefs, at = new Date()): boolean {
  if (!prefs.quiet) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  const from = minutes(prefs.quiet.from);
  const to = minutes(prefs.quiet.to);
  return from <= to ? now >= from && now < to : now >= from || now < to;
}

// ---- Sending.

function send(title: string, body: string, tag: string): void {
  const desktop = desktopApp();
  if (desktop) return desktop.notify(title, body, tag);
  try {
    new Notification(title, { body, tag, icon: "/icon.png" });
  } catch {
    /* some browsers throw outside a secure context */
  }
}

/** A one-off notification, when the user turned them on. Not about limits, so quiet hours and mutes do not apply. */
export function notifyIfEnabled(title: string, body: string, tag: string): void {
  if (notifyEnabled()) send(title, body, tag);
}

/** Shows that notifications reach this computer, whatever the settings say. */
export function sendTestNotification(): void {
  send("Notifications work", "AI Cooldown tells you here when a limit resets, nears its end or runs out.", "test");
}

/**
 * Compares two consecutive usage answers for one account and notifies on the
 * transitions people actually wait for: a window resetting, crossing the
 * chosen share (90% unless changed), or hitting 100%.
 */
export function notifyChanges(account: Account, prev: Usage | undefined, next: Usage, now: number): void {
  if (!prev) return;
  const prefs = notifyPrefs();
  if (prefs.muted.includes(account.id) || inQuietHours(prefs, new Date(now))) return;
  for (const w of next.windows) {
    const before = prev.windows.find((p) => p.key === w.key);
    if (!before) continue;
    const resetIn = w.resetsAt ? formatCountdown(new Date(w.resetsAt).getTime() - now) : null;
    const tag = `${account.id}:${w.key}`;
    if (before.usedPercent >= 40 && w.usedPercent <= before.usedPercent - 30) {
      if (prefs.reset) send(`${account.label}: ${w.label} reset`, `${Math.round(100 - w.usedPercent)}% available again.`, `${tag}:reset`);
    } else if (before.usedPercent < 100 && w.usedPercent >= 100) {
      if (prefs.exhausted) send(`${account.label}: ${w.label} exhausted`, resetIn ? `Back in ${resetIn}.` : "Reset time not reported.", `${tag}:full`);
    } else if (prefs.threshold !== null && before.usedPercent < prefs.threshold && w.usedPercent >= prefs.threshold) {
      send(
        `${account.label}: ${w.label} at ${Math.round(w.usedPercent)}%`,
        resetIn ? `Resets in ${resetIn}. Consider switching accounts.` : "Consider switching accounts.",
        `${tag}:${prefs.threshold}`,
      );
    }
  }
}
