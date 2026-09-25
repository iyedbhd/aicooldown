import { desktopApp } from "./desktop";
import { formatCountdown } from "./format";
import type { Account, Usage } from "./types";

const KEY = "ai-usage-tracker:notify";

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

function send(title: string, body: string, tag: string): void {
  const desktop = desktopApp();
  if (desktop) return desktop.notify(title, body, tag);
  try {
    new Notification(title, { body, tag, icon: "/icon.png" });
  } catch {
    /* some browsers throw outside a secure context */
  }
}

/** A one-off notification, when the user turned them on. */
export function notifyIfEnabled(title: string, body: string, tag: string): void {
  if (notifyEnabled()) send(title, body, tag);
}

/**
 * Compares two consecutive usage answers for one account and notifies on the
 * transitions people actually wait for: a window resetting, crossing 90%,
 * or hitting 100%.
 */
export function notifyChanges(account: Account, prev: Usage | undefined, next: Usage, now: number): void {
  if (!prev) return;
  for (const w of next.windows) {
    const before = prev.windows.find((p) => p.key === w.key);
    if (!before) continue;
    const resetIn = w.resetsAt ? formatCountdown(new Date(w.resetsAt).getTime() - now) : null;
    const tag = `${account.id}:${w.key}`;
    if (before.usedPercent >= 40 && w.usedPercent <= before.usedPercent - 30) {
      send(`${account.label}: ${w.label} reset`, `${Math.round(100 - w.usedPercent)}% available again.`, `${tag}:reset`);
    } else if (before.usedPercent < 100 && w.usedPercent >= 100) {
      send(`${account.label}: ${w.label} exhausted`, resetIn ? `Back in ${resetIn}.` : "Reset time not reported.", `${tag}:full`);
    } else if (before.usedPercent < 90 && w.usedPercent >= 90) {
      send(
        `${account.label}: ${w.label} at ${Math.round(w.usedPercent)}%`,
        resetIn ? `Resets in ${resetIn}. Consider switching accounts.` : "Consider switching accounts.",
        `${tag}:90`,
      );
    }
  }
}
